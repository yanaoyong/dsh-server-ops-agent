import { now, atomic } from './ledger.js'

export function enqueueGap(db, host, last, current) {
  const start = Math.floor(last / 60) * 60, end = Math.floor(current / 60) * 60
  if (start < end) db.prepare('INSERT OR IGNORE INTO journal_gaps(host,start,end,cursor) VALUES(?,?,?,?)').run(host,start,end,start)
}
export async function collectJournal(db,host,read) {
  const gap = db.prepare('SELECT * FROM journal_gaps WHERE host=? AND cursor<end ORDER BY start LIMIT 1').get(host.id)
  if (!gap) return
  const start = gap.cursor, end = Math.min(start+1800,gap.end)
  let result
  try { result = await read(host,{task:'journal',machine:host.machine,start,end}) } catch { return }
  if (!Array.isArray(result.minutes) || result.minutes.some(([m,n])=>!Number.isSafeInteger(m) || m%60 || m<start || m>=end || !Number.isSafeInteger(n) || n<0)) return
  // One repeat for a truncated query. Persistent overload stays unknown and later intervals progress.
  if (!result.complete && !gap.tries) {
    db.prepare('UPDATE journal_gaps SET tries=1 WHERE host=? AND start=? AND end=? AND cursor=?').run(host.id,gap.start,gap.end,start)
    return
  }
  atomic(db,()=>{
    if (result.complete) for (const [m,n] of result.minutes)
      db.prepare('INSERT OR IGNORE INTO journal_minutes VALUES(?,?,?,?)').run(host.id,m,n,now())
    db.prepare('UPDATE journal_gaps SET cursor=?,tries=0 WHERE host=? AND start=? AND end=? AND cursor=?').run(end,host.id,gap.start,gap.end,start)
  })
}
export function ranges(minutes) {
  const runs = []
  for (const minute of minutes) {
    if (runs.length && runs.at(-1)[1] === minute) runs.at(-1)[1] += 60
    else runs.push([minute,minute+60])
  }
  return runs
}
export function supplement(db,host,report) {
  const {start,end} = report
  if (!report.ssh_logins || !db.prepare('SELECT 1 FROM journal_gaps WHERE host=? AND start<? AND end>? LIMIT 1').get(host,end,start)) return
  const minutes = new Map()
  for (const row of db.prepare("SELECT value FROM samples WHERE host=? AND signal='可疑 IP' AND ts>=? AND ts<? ORDER BY ts,id").all(host,start-240,end)) {
    const s = JSON.parse(row.value)
    if (!s.window_complete || !Array.isArray(s.minute_failures)) continue
    s.minute_failures.forEach((n,i)=>{ const t=s.window_start+i*60; if(t>=start && t<end) minutes.set(t,n) })
  }
  const recovered = []
  for (const {minute,failures} of db.prepare('SELECT minute,failures FROM journal_minutes WHERE host=? AND minute>=? AND minute<? ORDER BY minute').all(host,start,end)) {
    if (!minutes.has(minute)) { minutes.set(minute,failures); recovered.push(minute) }
  }
  const unknown = []
  for (let t=start;t<end;t+=60) if (!minutes.has(t)) unknown.push(t)
  report.ssh_logins = { covered_minutes:minutes.size, missing_minutes:unknown.length,
    failures:minutes.size ? [...minutes.values()].reduce((a,b)=>a+b,0) : null,
    source:'sshd journal', recovered:ranges(recovered), unknown:ranges(unknown) }
}
export function directoryStats(db,host) {
  return db.prepare(`WITH ranked AS (SELECT *,row_number() OVER (PARTITION BY source ORDER BY ts DESC) rn
    FROM directory_sizes WHERE host=?) SELECT r.source,r.ts,r.bytes,r.reason,p.ts previous_ts,p.bytes previous_bytes
    FROM ranked r LEFT JOIN directory_sizes p ON p.host=r.host AND p.source=r.source AND p.ts=(
      SELECT max(ts) FROM directory_sizes WHERE host=r.host AND source=r.source AND ts<r.ts AND bytes IS NOT NULL)
    WHERE r.rn=1 ORDER BY (r.bytes-p.bytes) DESC,r.source`).all(host)
}
