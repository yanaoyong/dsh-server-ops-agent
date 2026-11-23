import { now, hash } from './ledger.js'
import { directoryStats } from './retained.js'

export function sanitizeEvidence(rows,host) {
  for (const r of rows) {
    const value = JSON.parse(r.value)
    if (Array.isArray(value.top))
      value.top = value.top.map(([ip, count, ...distribution]) => [
        '来源-' + hash(host + ip).slice(0, 12),
        count, ...distribution
      ])
    if (r.signal === 'SSH 连接') delete value.source
    r.value = JSON.stringify(value)
  }
}
export function currentHostObservations(db,host,cited=[]) {
  const rows = db.prepare(`SELECT id,ts,signal,value,state FROM samples WHERE host=? AND id IN (
    SELECT MAX(id) FROM samples WHERE host=? GROUP BY signal
    UNION SELECT MAX(id) FROM samples WHERE host=? AND state!='unknown' GROUP BY signal
    UNION SELECT value FROM json_each(?)) ORDER BY id DESC`).all(host,host,host,
      JSON.stringify(cited))
  sanitizeEvidence(rows,host)
  return {host,as_of:now(),observations:rows,directories:directoryStats(db,host)}
}
