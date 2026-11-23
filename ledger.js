import { redact } from './redact.js'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { privateDir, root } from './paths.js'

export const now = () => Math.floor(Date.now() / 1000)
export const hash = (data) => createHash('sha256').update(data).digest('hex')
export function openLedger(dir = root) {
  privateDir(dir)
  const db = new DatabaseSync(path.join(dir, 'ledger.sqlite'))
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY, joined INT, alias TEXT);
    CREATE TABLE IF NOT EXISTS retired_hosts(host TEXT PRIMARY KEY);
    CREATE VIEW IF NOT EXISTS workbench_hosts AS SELECT * FROM hosts WHERE id NOT IN (SELECT host FROM retired_hosts);
    CREATE TABLE IF NOT EXISTS operator_questions(job TEXT PRIMARY KEY REFERENCES investigations(id),host TEXT NOT NULL REFERENCES hosts(id));
    CREATE INDEX IF NOT EXISTS operator_host ON operator_questions(host);
    CREATE TABLE IF NOT EXISTS limits(host TEXT PRIMARY KEY REFERENCES hosts(id),body TEXT);
    CREATE TABLE IF NOT EXISTS identities(host TEXT PRIMARY KEY REFERENCES hosts(id),machine TEXT);
    CREATE TABLE IF NOT EXISTS enrolled(host TEXT PRIMARY KEY REFERENCES hosts(id));
    CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, host REFERENCES hosts(id), signal TEXT, opened INT, closed INT, hits INT);
    CREATE UNIQUE INDEX IF NOT EXISTS active_case ON cases(host,signal) WHERE closed IS NULL;
    CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY,host REFERENCES hosts(id),signal TEXT,ts INT,state TEXT,value TEXT,incident REFERENCES cases(id));
    CREATE INDEX IF NOT EXISTS series ON samples(host,signal,ts);
    CREATE TABLE IF NOT EXISTS investigations(id TEXT PRIMARY KEY,incident REFERENCES cases(id),ts INT,question TEXT,status TEXT,attempts INT DEFAULT 0,retry INT DEFAULT 0,answer TEXT,parent_id TEXT REFERENCES investigations(id));
    CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,incident REFERENCES cases(id),body TEXT,digest TEXT,status TEXT,execution TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,incident TEXT,ts INT,actor TEXT,kind TEXT,detail TEXT);
    CREATE TRIGGER IF NOT EXISTS audit_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'append only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'append only'); END;
    CREATE TABLE IF NOT EXISTS reports(host TEXT,end INT,created INT,body TEXT,PRIMARY KEY(host,end));

    CREATE TABLE IF NOT EXISTS journal_gaps(host TEXT,start INT,end INT,cursor INT,tries INT DEFAULT 0,PRIMARY KEY(host,start,end));
    CREATE TABLE IF NOT EXISTS journal_minutes(host TEXT,minute INT,failures INT,checked INT,PRIMARY KEY(host,minute));
    CREATE TABLE IF NOT EXISTS directory_sizes(host TEXT,source TEXT,ts INT,bytes INT,reason TEXT,PRIMARY KEY(host,source,ts));

  `)
  // Existing ledgers predate reply links. Old questions have no recorded parent.
  const hasParent = () => db.prepare("SELECT 1 FROM pragma_table_info('investigations') WHERE name='parent_id'").get()
  if (!hasParent()) atomic(db, () => {
    if (!hasParent()) db.exec('ALTER TABLE investigations ADD COLUMN parent_id TEXT REFERENCES investigations(id)')
  })
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
export function reports(db, ts = now(), period = 120, localSignal = '本机采集') {
  const insert = db.prepare('INSERT OR IGNORE INTO reports VALUES(?,?,?,?)')
  for (const h of db.prepare('SELECT * FROM workbench_hosts').all()) {
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
      signals.add(localSignal)
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
          ssh_logins: summarizeSshLogins(rows, start, end),
          cases,
          actions,
          diskTrend: disks.find(disk => disk.mount === '/')?.trend ?? null,
          disks,
          late: ts > end + period
        })
      )
    }
  }
}
