import { redact } from './redact.js'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { privateDir, root, mac, sshInterval, testPilot } from './paths.js'

export const now = () => Math.floor(Date.now() / 1000)
export const hash = (data) => createHash('sha256').update(data).digest('hex')
export function openLedger(dir = root, { pilot = testPilot } = {}) {
  privateDir(dir)
  const db = new DatabaseSync(path.join(dir, 'ledger.sqlite'))
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY, joined INT, alias TEXT);
    CREATE TABLE IF NOT EXISTS retired_hosts(host TEXT PRIMARY KEY);
    CREATE VIEW IF NOT EXISTS workbench_hosts AS SELECT * FROM hosts WHERE id NOT IN (SELECT host FROM retired_hosts);
    CREATE TABLE IF NOT EXISTS ops_model(id INTEGER PRIMARY KEY CHECK(id=1),provider TEXT NOT NULL,model TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_questions(job TEXT PRIMARY KEY REFERENCES investigations(id),host TEXT NOT NULL REFERENCES hosts(id));
    CREATE INDEX IF NOT EXISTS operator_host ON operator_questions(host);
    CREATE TABLE IF NOT EXISTS limits(host TEXT PRIMARY KEY REFERENCES hosts(id),body TEXT);
    CREATE TABLE IF NOT EXISTS identities(host TEXT PRIMARY KEY REFERENCES hosts(id),machine TEXT);
    CREATE TABLE IF NOT EXISTS inventories(host TEXT PRIMARY KEY REFERENCES hosts(id),ts INT,body TEXT);
    CREATE TABLE IF NOT EXISTS container_entries(alias TEXT PRIMARY KEY,host TEXT NOT NULL REFERENCES hosts(id),container TEXT NOT NULL,port INT NOT NULL,inventory_ts INT NOT NULL);
    CREATE TABLE IF NOT EXISTS appnode_cursor(host TEXT PRIMARY KEY,last_slot INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS enrolled(host TEXT PRIMARY KEY REFERENCES hosts(id));
    CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, host REFERENCES hosts(id), signal TEXT, opened INT, closed INT, hits INT);
    CREATE UNIQUE INDEX IF NOT EXISTS active_case ON cases(host,signal) WHERE closed IS NULL;
    CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY,host REFERENCES hosts(id),signal TEXT,ts INT,state TEXT,value TEXT,incident REFERENCES cases(id));
    CREATE INDEX IF NOT EXISTS appnode_bad_by_time ON samples(host,ts) WHERE signal GLOB 'appnode · *' AND state='bad';
    CREATE INDEX IF NOT EXISTS series ON samples(host,signal,ts);
    CREATE TABLE IF NOT EXISTS investigations(id TEXT PRIMARY KEY,incident REFERENCES cases(id),ts INT,question TEXT,status TEXT,attempts INT DEFAULT 0,retry INT DEFAULT 0,answer TEXT,parent_id TEXT REFERENCES investigations(id));
    CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,incident REFERENCES cases(id),body TEXT,digest TEXT,status TEXT,execution TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS receipts(execution TEXT PRIMARY KEY,ts INT,result TEXT);
    CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,incident TEXT,ts INT,actor TEXT,kind TEXT,detail TEXT);
    CREATE INDEX IF NOT EXISTS scheduled_job_audit ON audit(json_extract(detail,'$.job')) WHERE kind='合并到期备份';
    CREATE TRIGGER IF NOT EXISTS audit_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'append only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'append only'); END;
    CREATE TABLE IF NOT EXISTS reports(host TEXT,end INT,created INT,body TEXT,PRIMARY KEY(host,end));

    CREATE TABLE IF NOT EXISTS journal_gaps(host TEXT,start INT,end INT,cursor INT,tries INT DEFAULT 0,PRIMARY KEY(host,start,end));
    CREATE TABLE IF NOT EXISTS journal_minutes(host TEXT,minute INT,failures INT,checked INT,PRIMARY KEY(host,minute));
    CREATE TABLE IF NOT EXISTS directory_sizes(host TEXT,source TEXT,ts INT,bytes INT,reason TEXT,PRIMARY KEY(host,source,ts));

    CREATE TABLE IF NOT EXISTS group_jobs(id TEXT PRIMARY KEY,host TEXT,ts INT,status TEXT,body TEXT);
    CREATE TABLE IF NOT EXISTS group_versions(id TEXT PRIMARY KEY,host TEXT,ts INT,manifest TEXT);
    CREATE TABLE IF NOT EXISTS fixture(id INT PRIMARY KEY, online INT, generation INT);
    INSERT OR IGNORE INTO fixture VALUES(1,1,0);
    CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY,ts INT,finished INT,status TEXT,stage TEXT,version TEXT,added INT DEFAULT 0,reused INT DEFAULT 0,detail TEXT);
    CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,host TEXT,ts INT,files INT);
    CREATE TABLE IF NOT EXISTS schedule(host TEXT PRIMARY KEY,due INT);
  `)
  // Existing ledgers predate reply links. Old questions have no recorded parent.
  const hasParent = () => db.prepare("SELECT 1 FROM pragma_table_info('investigations') WHERE name='parent_id'").get()
  if (!hasParent()) atomic(db, () => {
    if (!hasParent()) db.exec('ALTER TABLE investigations ADD COLUMN parent_id TEXT REFERENCES investigations(id)')
  })
  if (pilot) db.prepare('INSERT OR IGNORE INTO hosts VALUES(?,?,NULL)').run(mac, now())
  else db.prepare('INSERT OR IGNORE INTO retired_hosts VALUES(?)').run(mac)
  return db
}
export function atomic(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = work()
    db.exec('COMMIT')
    return value
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
export function audit(db, incident, actor, kind, detail, ts = now()) {
  db.prepare(
    'INSERT INTO audit(incident,ts,actor,kind,detail) VALUES(?,?,?,?,?)'
  ).run(incident, ts, actor, kind, JSON.stringify(detail))
}
export function queue(db, id, question = '', ts = now(), parentId = null) {
  question = redact(question)
  if (parentId !== null && (typeof parentId !== 'string' || !db.prepare(`
    SELECT 1 FROM investigations WHERE incident=? AND id=? AND status='done'
      AND length(json_extract(answer,'$.finding'))>0
  `).get(id,parentId))) throw Error('请选择本事件中已完成的回复')
  const qid = randomUUID()
  db.prepare(
    'INSERT INTO investigations(id,incident,ts,question,status,parent_id) VALUES(?,?,?,?,?,?)'
  ).run(qid, id, ts, question, 'queued', parentId)
  audit(
    db,
    id,
    question ? 'operator' : 'scheduler',
    question ? '追问' : '启动调查',
    { qid, question, ...(parentId && {parentId}) },
    ts
  )
  return qid
}
export function observe(db, host, signal, state, value, ts = now(), {openCase=true, investigate=true} = {}) {
  const save = () => {
    let c = db
      .prepare(
        'SELECT * FROM cases WHERE host=? AND signal=? AND closed IS NULL'
      )
      .get(host, signal)
    const abnormal = state === 'bad'
    if (abnormal && !c && openCase) {
      c = { id: randomUUID() }
      db.prepare('INSERT INTO cases VALUES(?,?,?,?,NULL,0)').run(
        c.id,
        host,
        signal,
        ts
      )
      audit(db, c.id, 'collector', '告警', { host, signal, value }, ts)
      if (investigate) queue(db, c.id, '', ts)
    }
    const result = db
      .prepare(
        'INSERT INTO samples(host,signal,ts,state,value,incident) VALUES(?,?,?,?,?,?)'
      )
      .run(host, signal, ts, state, JSON.stringify(value), c?.id ?? null)
    if (c && abnormal)
      db.prepare('UPDATE cases SET hits=hits+1 WHERE id=?').run(c.id)
    if (c && state === 'ok') {
      db.prepare('UPDATE cases SET closed=? WHERE id=?').run(ts, c.id)
      db.prepare(
        "UPDATE plans SET status='expired' WHERE incident=? AND status='pending'"
      ).run(c.id)
      audit(
        db,
        c.id,
        'collector',
        '业务恢复',
        { evidence: Number(result.lastInsertRowid), value },
        ts
      )
    }
    return c?.id
  }
  return db.isTransaction ? save() : atomic(db,save)
}
export function makePlan(db, id, ts = now()) {
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(id)
  if (!c || c.closed || c.host !== mac || c.signal !== '代理可用性')
    throw Error('没有适用的固定动作')
  const existing = db
    .prepare(
      "SELECT id FROM plans WHERE incident=? AND status IN ('pending','approved','executing','unknown')"
    )
    .get(id)
  if (existing) return existing.id
  const f = db.prepare('SELECT * FROM fixture').get()
  if (f.online) throw Error('上游已经在线')
  const ev = db
    .prepare(
      "SELECT id FROM samples WHERE incident=? AND state='bad' ORDER BY id DESC LIMIT 1"
    )
    .get(id)
  const body = {
    id: randomUUID(),
    incident: id,
    host: c.host,
    target: 'Mac 测试上游',
    action: 'enable-fixture-v1',
    args: { generation: f.generation },
    evidence: ev.id,
    expires: ts + 1800,
    impact: '恢复本机回环测试服务',
    verify: '通过原代理请求 /health 并核对响应正文'
  }
  const raw = JSON.stringify(body)
  db.prepare('INSERT INTO plans VALUES(?,?,?,?,?,NULL)').run(
    body.id,
    id,
    raw,
    hash(raw),
    'pending'
  )
  audit(db, id, 'controller', '提出计划', body, ts)
  return body.id
}
export function decide(db, id, digest, choice, ts = now()) {
  if (!['approve', 'reject'].includes(choice)) throw Error('决定无效')
  return atomic(db, () => {
    const p = db.prepare('SELECT * FROM plans WHERE id=?').get(id)
    if (!p || p.digest !== digest || hash(p.body) !== digest)
      throw Error('请重新核对计划')
    if (p.status !== 'pending') return p.status
    const b = JSON.parse(p.body)
    const status =
      ts >= b.expires
        ? 'expired'
        : choice === 'approve'
          ? 'approved'
          : 'rejected'
    db.prepare('UPDATE plans SET status=?,execution=? WHERE id=?').run(
      status,
      status === 'approved' ? randomUUID() : null,
      id
    )
    audit(db, p.incident, 'operator', status, { plan: id, digest }, ts)
    return status
  })
}
export function readBackupJobs(db, window) {
  const columns = window ? 'b.id,b.ts,b.finished,b.version,b.status,b.stage' : 'b.*'
  const selection = window
    ? 'WHERE b.finished>=? AND b.finished<? ORDER BY b.finished,b.rowid'
    : 'ORDER BY b.ts DESC,b.rowid DESC LIMIT 60'
  return db.prepare(
    `SELECT ${columns},a.detail AS schedule FROM backups b
     LEFT JOIN audit a ON a.kind='合并到期备份' AND json_extract(a.detail,'$.job')=b.id
     ${selection}`
  ).all(...(window || [])).map(row => ({ ...row, schedule: JSON.parse(row.schedule) }))
}
function summarizeSshLogins(rows, start, end) {
  const minutes = new Map()
  for (const row of rows) {
    if (row.signal !== '可疑 IP') continue
    const sample = JSON.parse(row.value)
    if (!sample.window_complete || !Array.isArray(sample.minute_failures)) continue
    for (const [index, failures] of sample.minute_failures.entries()) {
      const minute = sample.window_start + index * 60
      if (minute >= start && minute + 60 <= end) minutes.set(minute, failures)
    }
  }
  return {
    covered_minutes: minutes.size,
    missing_minutes: (end - start) / 60 - minutes.size,
    failures: minutes.size ? [...minutes.values()].reduce((sum, count) => sum + count, 0) : null
  }
}
function filesystemTrends(rows, signals, start) {
  const disks = new Map()
  for (const signal of signals) {
    const mount = signal === '主机容量' ? '/' :
      signal.startsWith('挂载容量 /') ? signal.slice('挂载容量 '.length) : null
    if (mount) disks.set(signal, { mount, samples: 0, first: null, last: null, trend: null })
  }
  for (const row of rows) {
    const disk = disks.get(row.signal)
    if (!disk || row.ts < start || row.state === 'unknown') continue
    const { available_bytes: available } = JSON.parse(row.value)
    if (!Number.isSafeInteger(available) || available < 0) continue
    const point = { id: row.id, ts: row.ts, available }
    disk.first ??= point
    disk.last = point
    disk.samples++
  }
  for (const disk of disks.values()) {
    if (disk.samples < 2) continue
    const { first, last } = disk
    const seconds = last.ts - first.ts
    if (seconds < 3600) continue
    const delta = first.available - last.available
    disk.trend = {
      first: first.id, last: last.id, seconds,
      bytesPerDay: Math.round(delta * 86400 / seconds),
      estimatedDays: delta > 0 ? Math.round(last.available * seconds / delta / 86400) : null
    }
  }
  return [...disks.values()].sort((a, b) => a.mount.localeCompare(b.mount))
}
export function latestEnd(t) {
  return Math.floor((t + 3600) / 86400) * 86400 - 3600
}
export function reports(db, ts = now(), localPeriod = 30, localSignal = '代理可用性') {
  const insert = db.prepare('INSERT OR IGNORE INTO reports VALUES(?,?,?,?)')
  for (const h of db.prepare('SELECT * FROM workbench_hosts').all()) {
    const period = h.alias ? sshInterval : localPeriod
    const prev = db
      .prepare('SELECT MAX(end) AS e FROM reports WHERE host=?')
      .get(h.id).e
    for (
      let end = (prev ?? latestEnd(h.joined)) + 86400;
      end <= ts;
      end += 86400
    ) {
      const start = end - 86400
      const rows = db
        .prepare(
          'SELECT id,signal,ts,state,value FROM samples WHERE host=? AND ts>=? AND ts<? ORDER BY ts,id'
        )
        .all(h.id, start - period * 2, end)
      const signals = new Set(
        db
          .prepare('SELECT DISTINCT signal FROM samples WHERE host=? AND ts<?')
          .all(h.id, end)
          .map((r) => r.signal)
      )
      signals.delete('网盘授权') // Hourly credential checks are reported with their observed time.
      signals.delete('网盘备份') // Job receipts have no continuous sampling interval.
      signals.add(h.alias ? 'SSH 连接' : localSignal)
      const coverage = {}
      for (const signal of signals) {
        const series = rows.filter((r) => r.signal === signal)
        let until = start
        const gaps = []
        for (let i = 0; i < series.length; i++) {
          const r = series[i]
          if (r.state === 'unknown') continue
          const a = Math.max(start, r.ts),
            b = Math.min(end, r.ts + period * 2, series[i + 1]?.ts ?? end)
          if (b <= a) continue
          if (a > until) gaps.push([until, a])
          until = Math.max(until, b)
        }
        if (until < end) gaps.push([until, end])
        coverage[signal] = {
          gaps,
          last:
            series.at(-1) ??
            db
              .prepare(
                'SELECT id,ts,state,value FROM samples WHERE host=? AND signal=? AND ts<? ORDER BY ts DESC,id DESC LIMIT 1'
              )
              .get(h.id, signal, end) ??
            null
        }
      }
      const cases = db
        .prepare(
          'SELECT id,signal,opened,CASE WHEN closed<? THEN closed END AS closed FROM cases WHERE host=? AND opened<? AND (closed IS NULL OR closed>=?)'
        )
        .all(end,h.id,end,start)
      const decisions = db
        .prepare(
          'SELECT p.id,p.incident,p.status,p.body,c.closed FROM plans p JOIN cases c ON c.id=p.incident WHERE c.host=? AND c.opened<?'
        )
        .all(h.id, end)
        .filter(
          (p) =>
            (!p.closed || p.closed >= end) &&
            JSON.parse(p.body).expires > end &&
            !db
              .prepare(
                "SELECT 1 FROM audit WHERE incident=? AND ts<? AND json_extract(detail,'$.plan')=? AND kind IN ('approved','rejected','expired')"
              )
              .get(p.incident, end, p.id) &&
            db
              .prepare(
                "SELECT 1 FROM audit WHERE incident=? AND ts<? AND kind='提出计划' AND json_extract(detail,'$.id')=?"
              )
              .get(p.incident, end, p.id)
        )
        .map((p) => p.id)
      const backup =
        db
          .prepare(
            `SELECT v.id,v.ts,MAX(b.finished) AS verified_at FROM versions v
             JOIN backups b ON b.version=v.id
             WHERE v.host=? AND v.ts<? AND b.finished<? AND b.status IN ('verified','restored','reindexed')
             GROUP BY v.id ORDER BY v.ts DESC,verified_at DESC,v.id LIMIT 1`
          )
          .get(h.id, end, end) ?? null
      const backupJobs = h.id === mac ? readBackupJobs(db, [start, end]) : []
      const actions = db
        .prepare(
          "SELECT a.seq,a.incident,a.ts,a.actor,a.kind FROM audit a JOIN cases c ON c.id=a.incident WHERE c.host=? AND a.ts>=? AND a.ts<? AND a.kind IN ('调查完成','执行固定动作','执行回执及业务复查','调查待重试') ORDER BY a.seq"
        )
        .all(h.id, start, end)
      const disks = filesystemTrends(rows, signals, start)
      insert.run(
        h.id,
        end,
        ts,
        JSON.stringify({
          start,
          end,
          coverage,
          ssh_logins: h.alias ? summarizeSshLogins(rows, start, end) : null,
          cases,
          decisions,
          backup,
          actions,
          backupJobs,
          authorization: db.prepare("SELECT id,ts,state FROM samples WHERE host=? AND signal='网盘授权' AND ts<? ORDER BY ts DESC,id DESC LIMIT 1").get(h.id,end) ?? null,
          diskTrend: disks.find(disk => disk.mount === '/')?.trend ?? null,
          disks,
          late: ts > end + period
        })
      )
    }
  }
}
