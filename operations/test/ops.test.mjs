import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  openLedger,
  now,
  observe,
  queue,
  reports,
  latestEnd,
  readBackupJobs,
  makePlan,
  decide,
  hash
} from '../ledger.js'
import { mac } from '../paths.js'
import { fixture, fault, recordProbe, execute } from '../fixture.js'
import { dispatch, investigationEvidence } from '../model.js'
import { backup, restore, recoverIndex, checkAuthorization } from '../backup.js'

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-test-'))
  const db = openLedger(root, {pilot:true})
  t.after(async () => {
    db.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { db, root }
}
test('real loopback 502 · reject and expire · digest binding · lost execution reply and reconciliation', async (t) => {
  const { db } = await setup(t),
    f = await fixture(db)
  t.after(() => f.close())
  assert.equal((await f.probe()).edge.http, 200)
  fault(db)
  const observed = await f.probe()
  assert.equal(observed.edge.http, 502)
  const id = recordProbe(db, observed)
  assert.equal(recordProbe(db, observed), id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM investigations').get().n, 1)
  const plan = () =>
    db.prepare('SELECT * FROM plans WHERE id=?').get(makePlan(db, id))
  const one = plan()
  assert.throws(() => decide(db, one.id, 'wrong', 'approve'))
  assert.equal(decide(db, one.id, one.digest, 'reject'), 'rejected')
  await execute(db, f.probe)
  assert.equal((await f.probe()).edge.http, 502)
  const two = plan()
  assert.equal(
    decide(db, two.id, two.digest, 'approve', now() + 1900),
    'expired'
  )
  const three = plan()
  assert.equal(decide(db, three.id, three.digest, 'approve'), 'approved')
  assert.equal(decide(db, three.id, three.digest, 'approve'), 'approved')
  await execute(db, f.probe, { loseReceipt: true })
  assert.equal(
    db.prepare('SELECT status FROM plans WHERE id=?').get(three.id).status,
    'executing'
  )
  await execute(db, f.probe)
  await execute(db, f.probe)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM receipts').get().n, 1)
  assert.equal(
    db.prepare('SELECT status FROM plans WHERE id=?').get(three.id).status,
    'verified'
  )
  assert.equal((await f.probe()).edge.http, 200)
  fault(db)
  assert.notEqual(recordProbe(db, await f.probe()), id)
})
test('Beijing windows across three missed mornings, second-host isolation and model outage', async (t) => {
  const { db } = await setup(t)
  const start = Date.parse('2024-11-16T06:40:00+08:00') / 1000
  db.prepare('UPDATE hosts SET joined=?').run(start)
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(
    'test-vps',
    start,
    'offline-test'
  )
  const id = observe(
    db,
    'test-vps',
    'SSH 连接',
    'bad',
    { verified: false },
    start
  )
  assert.throws(() => makePlan(db, id))
  observe(db, mac, '代理可用性', 'bad', { http: 502 }, start)
  observe(db, mac, '代理可用性', 'ok', { http: 200 }, start + 30)
  await dispatch(db, async () => {
    throw Error('offline')
  })
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM investigations WHERE status='retry'")
      .get().n,
    1
  )
  const wake = start + 86400 * 2 + 1800
  reports(db, wake)
  reports(db, wake + 10)
  const rows = db.prepare('SELECT * FROM reports ORDER BY end,host').all()
  assert.equal(rows.length, 6)
  assert.equal(rows.at(-1).end, latestEnd(wake))
  assert.equal(rows[0].end, Date.parse('2024-11-16T07:00:00+08:00') / 1000)
  for (const row of rows) {
    const body = JSON.parse(row.body)
    assert(body.late)
    assert(Object.values(body.coverage).every((c) => c.gaps.length))
    assert(!body.cases.some((c) => row.host === mac && c.id === id))
  }
  assert.equal(
    JSON.parse(rows.find((r) => r.host === mac).body).cases.length,
    1
  )
})
test('incremental backup, failed verification, historical restore and clean catalog rebuild', async (t) => {
  const { db, root } = await setup(t)
  const objects = new Map(),
    versions = []
  const store = {
    async write(kind, obj) {
      const id = hash(JSON.stringify(obj))
      objects.set(id, structuredClone(obj))
      if (kind === 'version') versions.push(id)
      return id
    },
    async read(kind, id) {
      if (!objects.has(id)) throw Error('missing')
      return structuredClone(objects.get(id))
    },
    list: async () => versions
  }
  const src = path.join(root, 'source')
  await fs.mkdir(src)
  await fs.writeFile(path.join(src, 'keep'), 'a')
  await fs.writeFile(path.join(src, 'lost'), 'b')
  const one = await backup(db, store, src)
  await fs.rename(path.join(src, 'lost'), path.join(root, 'moved'))
  await fs.writeFile(path.join(src, 'new'), 'c')
  const two = await backup(db, store, src)
  assert.deepEqual([one.added, one.reused, two.added, two.reused], [2, 0, 1, 1])
  const fresh = openLedger(path.join(root, 'clean'), {pilot:true})
  try {
    assert.equal((await recoverIndex(fresh, store)).versions, 2)
    const first = await restore(
      fresh,
      store,
      one.version,
      path.join(root, 'restored')
    )
    assert.equal(await fs.readFile(path.join(first.dest, 'lost'), 'utf8'), 'b')
    const second = await restore(
      fresh,
      store,
      two.version,
      path.join(root, 'restored')
    )
    assert.deepEqual(await fs.readdir(second.dest), ['keep', 'new'])
  } finally {
    fresh.close()
  }
  const bad = {
    ...store,
    read: async () => {
      throw Error('读回失败')
    }
  }
  await assert.rejects(backup(db, bad, src))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM versions').get().n, 2)
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM backups WHERE status='failed'").get().n,
    1
  )
})

test('event questions redact pasted credentials before persistence', async (t) => {
  const { db } = await setup(t)
  const id = observe(db, mac, '可用性', 'bad', { http: 502 })
  const { queue } = await import('../ledger.js')
  const qid = queue(db, id, 'password=demo-test-value 是否影响探针？')
  const q = db
    .prepare('SELECT question FROM investigations WHERE id=?')
    .get(qid)
  assert.equal(q.question, 'password=[已隐藏] 是否影响探针？')
  assert(
    !db
      .prepare("SELECT 1 FROM audit WHERE detail LIKE '%demo-test-value%'")
      .get()
  )
})

test('per-host signals distinguish SSH clues, independent bans, restart bursts and capacity', async (t) => {
  const { db } = await setup(t)
  const { recordSignals, setLimits } = await import('../signals.js')
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run('linux-test', now(), 'test')
  setLimits(db, 'linux-test', { diskPct: 80 })
  const sample = (n, count, ts) =>
    recordSignals(
      db,
      'linux-test',
      {
        '可疑 IP': {
          state: 'ok',
          facts: { journal_visible: true, top: [['192.0.2.10', n]] }
        },
        'fail2ban 既有策略': { state: 'ok', facts: { banned: 4 } },
        '容器 base': {
          state: 'ok',
          facts: {
            container_id: 'sample',
            status: ['running', 'healthy', String(count)]
          }
        },
        '挂载容量 /data': { state: 'ok', facts: { used_pct: 81 } }
      },
      ts
    )
  sample(1, 0, now() - 120)
  sample(8, 3, now())
  const signals = db
    .prepare('SELECT signal FROM cases ORDER BY signal')
    .all()
    .map((r) => r.signal)
  assert.deepEqual(
    signals.sort(),
    ['可疑 IP', '容器 base', '挂载容量 /data'].sort()
  )
  assert.equal(db.prepare('SELECT count(*) n FROM receipts').get().n, 0)
})

test('missed backup slots coalesce and a lost publish reply is reconciled from cloud', async (t) => {
  const { db } = await setup(t)
  const { claimBackup, reconcileBackups } = await import('../backup.js')
  const ts = now(),
    due = ts - 86400 * 3 - 60
  db.prepare('INSERT INTO schedule VALUES(?,?)').run(mac, due)
  const job = claimBackup(db, ts, true)
  assert.equal(claimBackup(db, ts + 1, true), null)
  const claim = JSON.parse(
    db.prepare("SELECT detail FROM audit WHERE kind='合并到期备份'").get()
      .detail
  )
  assert.equal(claim.missed, 3)
  db.prepare("UPDATE backups SET status='interrupted' WHERE id=?").run(job)
  const version = hash('sample-manifest')
  const manifest = {
    job,
    ts,
    host: mac,
    schema: 1,
    files: [],
    dirs: [],
    added: 0,
    reused: 0
  }
  const store = { list: async () => [version], read: async () => manifest }
  await reconcileBackups(db, store)
  await reconcileBackups(db, store)
  assert.equal(db.prepare('SELECT count(*) n FROM versions').get().n, 1)
  assert.equal(
    db.prepare('SELECT status FROM backups WHERE id=?').get(job).status,
    'verified'
  )
})

test('a backfilled report cannot use a cloud receipt or a recovery observed after its cutoff', async (t) => {
  const { db } = await setup(t)
  const end = latestEnd(now()) + 86400
  db.prepare('UPDATE hosts SET joined=? WHERE id=?').run(end - 7200, mac)
  const incident = observe(db, mac, '代理可用性', 'bad', { http: 502 }, end - 120)
  observe(db, mac, '代理可用性', 'ok', { http: 200 }, end + 80)
  const snapshots = [
    ['earlier', end - 3600, end - 3500],
    ['crossed', end - 60, end + 40]
  ]
  for (const [id, snapshot, finish] of snapshots) {
    db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(id, mac, snapshot, 1)
    db.prepare(
      "INSERT INTO backups(id,ts,finished,status,stage,version) VALUES(?,?,?,'verified','云端回读通过',?)"
    ).run(id, snapshot, finish, id)
  }
  reports(db, end + 86400 + 300)
  const report = limit => JSON.parse(
    db.prepare('SELECT body FROM reports WHERE host=? AND end=?').get(mac, limit).body
  )
  assert.equal(report(end).backup.id, 'earlier')
  assert.equal(report(end).backup.verified_at, end - 3500)
  assert.equal(report(end).cases.find(c => c.id === incident).closed, null)
  assert.equal(report(end + 86400).backup.id, 'crossed')
  assert.equal(report(end + 86400).cases.find(c => c.id === incident).closed, end + 80)
})

test('credential expiry and unreadable status preserve distinct evidence for one incident', async (t) => {
  const { db } = await setup(t)
  const status = authorized => async () => ({ authorized })
  await checkAuthorization(db, status(false))
  await assert.rejects(checkAuthorization(db, async () => { throw Error('offline') }))
  await checkAuthorization(db, status(false))
  await checkAuthorization(db, status(true))
  const events = db.prepare("SELECT closed,hits FROM cases WHERE signal='网盘授权'").all()
  assert.equal(events.length, 1)
  assert.ok(events[0].closed)
  assert.equal(events[0].hits, 2)
  const samples = db.prepare("SELECT state FROM samples WHERE signal='网盘授权' ORDER BY id").all()
  assert.deepEqual(samples.map(row => row.state), ['bad', 'unknown', 'bad', 'ok'])
})

test('follow-up keeps the original alert and prior cited rows after they leave the six latest observations', async t => {
  const { db } = await setup(t)
  const event = observe(db, mac, '代理可用性', 'bad', { http: 502 })
  const first = db.prepare('SELECT MIN(id) AS id FROM samples WHERE incident=?').get(event).id
  observe(db, mac, '代理可用性', 'bad', { http: 502 })
  const cited = db.prepare('SELECT MAX(id) AS id FROM samples WHERE incident=?').get(event).id
  const foreign = observe(db, mac, '网盘备份', 'bad', { job: 'another-case' })
  const other = db.prepare('SELECT id FROM samples WHERE incident=?').get(foreign).id
  db.prepare("UPDATE investigations SET status='done',answer=? WHERE incident=?")
    .run(JSON.stringify({ evidence: [cited] }), event)
  for (let i = 0; i < 12; i++) observe(db, mac, '代理可用性', 'bad', { http: 502 })
  observe(db, mac, '代理可用性', 'ok', { http: 200 })
  const followup = queue(db, event, '最初的告警和最后一次观测有何变化？')
  const job = db.prepare('SELECT * FROM investigations WHERE id=?').get(followup)
  const evidence = investigationEvidence(db, job)
  const ids = evidence.observations.map(r => r.id)
  assert.equal(evidence.prior.length, 1)
  assert.ok(ids.includes(first) && ids.includes(cited))
  assert.equal(ids.includes(other), false)
  assert.equal(evidence.observations[0].state, 'ok')
})

test('initial overdue backup survives schedule advancement and reports retain its original due times', async t => {
  const { db } = await setup(t)
  const { setBackupSchedule, recordBackupFreshness, claimBackup } = await import('../backup.js')
  const t0 = now() - 4 * 86400
  const policy = setBackupSchedule(db, true, t0)
  assert.equal(setBackupSchedule(db, true, t0 + 1).due, policy.due)
  recordBackupFreshness(db, policy, t0 + 30)
  assert.equal(db.prepare("SELECT state FROM samples WHERE signal='备份时效'").get().state, 'unknown')
  const start = policy.due + 2 * 86400 + 90
  const job = claimBackup(db, start, true)
  const next = db.prepare('SELECT due FROM schedule WHERE host=?').get(mac)
  const overdue = recordBackupFreshness(db, next, start)
  assert.ok(overdue)
  const row = readBackupJobs(db)[0]
  assert.equal(row.schedule.job, job)
  assert.equal(row.schedule.missed, 2)
  db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run('version', mac, start, 1)
  db.prepare("UPDATE backups SET status='verified',version='version',finished=? WHERE id=?").run(start + 5, job)
  recordBackupFreshness(db, next, start + 6)
  assert.equal(db.prepare('SELECT closed FROM cases WHERE id=?').get(overdue).closed, start + 6)
  assert.deepEqual(readBackupJobs(db, [start, start + 20])[0].schedule, row.schedule)
  assert.equal(readBackupJobs(db, [start - 86400, start]).length, 0)
  setBackupSchedule(db, false, start + 7)
  setBackupSchedule(db, false, start + 8)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE kind='停用每日备份'").get().n, 1)
})

test('partial SSH evidence cannot close an incident, and daily counts deduplicate overlapping minutes', async t => {
  const { db } = await setup(t)
  const { recordSignals } = await import('../signals.js')
  const end = latestEnd(now()) + 86400, start = end - 900
  const host = 'journal-test'
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(host, start, 'sample')
  function add(offset, values, complete) {
    const total = values.reduce((a, b) => a + b)
    const facts = { window_start: start + offset, window_complete: complete, journal_visible: true,
      minute_failures: values, top: total ? [['192.0.2.10', total, { by_minute: values }]] : [] }
    recordSignals(db, host, { '可疑 IP': { state: 'ok', facts } }, start + offset + 301)
  }
  add(0, [0, 1, 2, 3, 2], true)
  const existing = db.prepare('SELECT id FROM cases WHERE host=?').get(host)
  const job = db.prepare('SELECT * FROM investigations WHERE incident=?').get(existing.id)
  const persisted = investigationEvidence(db, job).observations[0].value
  assert.ok(!persisted.includes('192.0.2.10') && JSON.parse(persisted).top[0][2].by_minute.length === 5)
  add(60, [0, 0, 0, 0, 0], false)
  assert.equal(db.prepare('SELECT closed FROM cases WHERE id=?').get(existing.id).closed, null)
  add(120, [2, 3, 2, 0, 0], true)
  assert.ok(db.prepare('SELECT closed FROM cases WHERE id=?').get(existing.id).closed)
  reports(db, end + 10)
  const report = JSON.parse(db.prepare('SELECT body FROM reports WHERE host=? AND end=?').get(host, end).body)
  assert.deepEqual(report.ssh_logins, { covered_minutes: 7, missing_minutes: 1433, failures: 8 })
})

test('new pack readback is checked before publication and a later restore reads the pack again', async t => {
  const { db, root } = await setup(t)
  const source = path.join(root, 'files')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'example.txt'), 'example')
  const objects = new Map()
  const reads = []
  let corrupt = true
  const store = {
    async read(kind, id) {
      reads.push(kind)
      return structuredClone(objects.get(id))
    },
    async write(kind, value, verifiedPacks) {
      const id = hash(JSON.stringify(value))
      objects.set(id, structuredClone(value))
      const remote = await this.read(kind, id)
      if (kind === 'pack') {
        if (corrupt) remote[Object.keys(remote)[0]] = 'AAAA'
        verifiedPacks.set(id, remote)
      }
      return id
    }
  }
  await assert.rejects(backup(db, store, source), /文件回读摘要不符/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 0)
  corrupt = false
  reads.length = 0
  const result = await backup(db, store, source)
  assert.deepEqual(reads, ['pack', 'version'])
  reads.length = 0
  await restore(db, store, result.version, path.join(root, 'restored'))
  assert.deepEqual(reads, ['version', 'pack'])
})

test('daily disk trends use each filesystem’s own valid in-window samples', async t => {
  const { db } = await setup(t)
  const end = latestEnd(now()), start = end - 86400
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run('vps', start + 1, 'example')
  const sample = (signal, offset, bytes, state = 'ok') =>
    observe(db, 'vps', signal, state, { available_bytes: bytes }, start + offset)
  sample('主机容量', -10, 70000)
  sample('主机容量', 10, 3000)
  sample('主机容量', 3610, 2000)
  sample('主机容量', 5000, null)
  sample('主机容量', 86400, 500)
  sample('挂载容量 /data', 50, 6000)
  sample('挂载容量 /data', 3650, 8000)
  sample('挂载容量 /srv/appnode', 1400, 750)
  sample('挂载容量 /srv/appnode', 8000, 0, 'unknown')
  sample('挂载容量 /empty', 45, null, 'unknown')
  reports(db, end)
  const report = JSON.parse(db.prepare('SELECT body FROM reports WHERE host=? AND end=?').get('vps', end).body)
  const disks = Object.fromEntries(report.disks.map(disk => [disk.mount, disk]))
  assert.deepEqual(disks['/'].trend, report.diskTrend)
  assert.equal(disks['/'].samples, 2)
  assert.equal(disks['/'].trend.bytesPerDay, 24000)
  assert.equal(disks['/'].last.available, 2000)
  assert.equal(disks['/data'].trend.bytesPerDay, -48000)
  assert.equal(disks['/data'].trend.estimatedDays, null)
  assert.equal(disks['/srv/appnode'].last.available, 750)
  assert.equal(disks['/srv/appnode'].trend, null)
  assert.equal(disks['/empty'].samples, 0)
  assert.equal(disks['/empty'].last, null)
})

test('continuing a specific reply preserves its branch, cited samples and event scope', async t => {
  const {db,root}=await setup(t)
  const event=observe(db,mac,'容量','bad',{used_pct:85})
  const other=observe(db,mac,'单位','bad',{count:1})
  const add=(question,parent=null)=>queue(db,event,question,now(),parent)
  const complete=(id,finding,evidence=[])=>db.prepare("UPDATE investigations SET status='done',answer=? WHERE id=?")
    .run(JSON.stringify({finding,evidence}),id)
  const first=add('第一问')
  const unfinished=add('尚未回答')
  const foreign=db.prepare('SELECT id FROM investigations WHERE incident=?').get(other).id
  complete(foreign,'另一事件')
  for (const id of [unfinished,foreign,'absent']) assert.throws(()=>add('不应入队',id),/本事件中已完成/)
  observe(db,mac,'容量','bad',{used_pct:86})
  const sample=db.prepare('SELECT max(id) id FROM samples WHERE incident=?').get(event).id
  complete(first,'第一条结论',[sample])
  for(let i=0;i<8;i++) observe(db,mac,'容量','bad',{used_pct:87})
  const child=add('针对第一条',first)
  complete(child,'第二轮结论')
  complete(add('另一分支',first),'不相关一')
  complete(add('独立问题'),'不相关二')
  const last=add('针对第二轮',child)
  const reopened=openLedger(root,{pilot:true})
  try {
    const job=reopened.prepare('SELECT * FROM investigations WHERE id=?').get(last)
    assert.equal(job.parent_id,child)
    const record=investigationEvidence(reopened,job)
    assert.equal(record.replyTo,child)
    assert.deepEqual(record.prior.map(r=>r.id),[first,child])
    assert.ok(record.observations.some(r=>r.id===sample))
    assert.equal(reopened.prepare('SELECT parent_id FROM investigations WHERE id=?').get(first).parent_id,null)
  } finally {reopened.close()}
})
