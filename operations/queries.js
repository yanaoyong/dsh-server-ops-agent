import { groupState } from './groups.js'
import { directoryStats, supplement } from './retained.js'
import path from 'node:path'
import { mac, root, sshInterval } from './paths.js'
import { now, readBackupJobs } from './ledger.js'
export function pendingPlans(db) {
  return db
    .prepare(
      "SELECT * FROM plans WHERE incident IN (SELECT id FROM cases WHERE host IN (SELECT id FROM workbench_hosts)) AND status='pending' AND json_extract(body,'$.expires')>?"
    )
    .all(now())
    .map((p) => ({ ...p, body: JSON.parse(p.body) }))
}
export function resourceHistory(db, host, resource, end = now()) {
  const rootVolume = resource === '/'
  if (!rootVolume && !['/data', '/srv/appnode'].includes(resource))
    throw Error('未知的资源历史')
  const fields = rootVolume
    ? "json_extract(value,'$.root_used_pct') AS pct, json_extract(value,'$.available_memory_pct') AS memory, json_extract(value,'$.load15') AS load"
    : "json_extract(value,'$.used_pct') AS pct"
  const signal = rootVolume ? '主机容量' : '挂载容量 ' + resource
  const start = end - 86400
  const rows = db.prepare(`
    SELECT ts, state, ${fields},
           json_extract(value,'$.available_bytes') AS bytes
    FROM samples WHERE host=? AND host IN (SELECT id FROM workbench_hosts)
      AND signal=? AND ts BETWEEN ? AND ?
    ORDER BY ts,id
  `).all(host, signal, start, end)
  return {start, end, rows}
}
export function appnodeHistory(db, host, end = now()) {
  return resourceHistory(db, host, '/srv/appnode', end)
}
export function overview(db) {
  const ordered = (sql, ...args) => db.prepare(sql).all(...args)
  const events = ordered(`
    WITH visible AS (SELECT * FROM cases WHERE host IN (SELECT id FROM workbench_hosts)),
    history AS (SELECT * FROM visible WHERE closed IS NOT NULL ORDER BY closed DESC,id LIMIT 100)
    SELECT * FROM visible WHERE closed IS NULL UNION ALL SELECT * FROM history ORDER BY opened DESC,id
  `)
  const reportsList = ordered(
    'SELECT * FROM reports WHERE host IN (SELECT id FROM workbench_hosts) ORDER BY end DESC LIMIT 60'
  ).map((r) => ({ ...r, body: JSON.parse(r.body) }))
  for (const r of reportsList) {
    supplement(db,r.host,r.body)
    r.body.business=db.prepare(`SELECT signal,count(*) failures,max(ts) last FROM samples
      WHERE host=? AND signal GLOB 'appnode · *' AND state='bad' AND ts>=? AND ts<? GROUP BY signal`)
      .all(r.host,r.body.start,r.end)
  }
  const samples = ordered(
    'SELECT s.* FROM samples s JOIN (SELECT MAX(id) id FROM samples WHERE host IN (SELECT id FROM workbench_hosts) GROUP BY host,signal) last ON s.id=last.id'
  ).map((s) => ({ ...s, value: JSON.parse(s.value) }))
  const pilot = Boolean(db.prepare('SELECT 1 FROM workbench_hosts WHERE id=?').get(mac))
  return {
    agentHosts: ordered('SELECT h.id FROM workbench_hosts h JOIN enrolled e ON e.host=h.id JOIN identities i ON i.host=h.id ORDER BY h.id').map(h => h.id),
    hosts: ordered('SELECT id,alias FROM workbench_hosts ORDER BY joined,id'),
    groups: groupState(db),
    directories: ordered('SELECT id FROM hosts WHERE alias IS NOT NULL').flatMap(({id})=>directoryStats(db,id).map(row=>({...row,host:id}))),
    containerEntries: ordered('SELECT host,container,alias,port,inventory_ts FROM container_entries ORDER BY host,container,alias'),
    inventories: ordered('SELECT * FROM inventories ORDER BY host').map(
      (i) => ({ ...i, body: JSON.parse(i.body) })
    ),
    events,
    reports: reportsList,
    samples,
    plans: pendingPlans(db),
    versions: ordered(
      'SELECT * FROM versions WHERE host IN (SELECT id FROM workbench_hosts) ORDER BY ts DESC,rowid DESC LIMIT 60'
    ),
    jobs: pilot ? readBackupJobs(db) : [],
    policy: pilot ? db.prepare('SELECT due FROM schedule WHERE host=?').get(mac) ?? null : null,
    source: pilot ? path.join(root, 'pilot-files') : null,
    sshInterval,
    clock: now()
  }
}
export function detail(db, id) {
  const ordered = (sql, ...args) => db.prepare(sql).all(...args)
  const event = db.prepare('SELECT * FROM cases WHERE id=? AND host IN (SELECT id FROM workbench_hosts)').get(id)
  if (!event) throw Error('找不到事件')
  return {
    event,
    samples: ordered(
      `WITH evidence(id) AS (
        SELECT id FROM (SELECT id FROM samples WHERE incident=? ORDER BY id DESC LIMIT 20)
        UNION SELECT json_each.value FROM investigations, json_each(investigations.answer,'$.evidence') WHERE incident=?
        UNION SELECT json_extract(body,'$.evidence') FROM plans WHERE incident=?
        UNION SELECT MIN(id) FROM samples WHERE incident=?
      ) SELECT s.* FROM samples s JOIN evidence ON s.id=evidence.id WHERE s.incident=? ORDER BY s.id DESC`,
      id,
      id,
      id,
      id,
      id
    ),
    investigations: ordered(
      'SELECT * FROM investigations WHERE incident=? ORDER BY ts,rowid',
      id
    ),
    plans: ordered(
      'SELECT * FROM plans WHERE incident=? ORDER BY rowid DESC',
      id
    ).map((p) => ({ ...p, body: JSON.parse(p.body) })),
    audit: ordered('SELECT * FROM audit WHERE incident=? ORDER BY seq', id)
  }
}
