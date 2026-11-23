import { supplement } from './retained.js'
import { sshInterval } from './paths.js'
import { now } from './ledger.js'

export function resourceHistory(db, host, resource, end = now()) {
  const rootVolume = resource === '/'
  if (!rootVolume)
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
  for (const report of reportsList) supplement(db, report.host, report.body)
  const samples = ordered(
    'SELECT s.* FROM samples s JOIN (SELECT MAX(id) id FROM samples WHERE host IN (SELECT id FROM workbench_hosts) GROUP BY host,signal) last ON s.id=last.id'
  ).map((s) => ({ ...s, value: JSON.parse(s.value) }))
  const hosts = ordered('SELECT id FROM workbench_hosts ORDER BY joined,id')
  return {
    agentHosts: hosts.map(({ id }) => id),
    hosts,
    events,
    reports: reportsList,
    samples,
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
