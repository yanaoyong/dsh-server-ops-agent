import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pkg } from './paths.js'
import { now, atomic } from './ledger.js'


export function enqueueGap(db, host, last, current) {
  const start = Math.floor(last / 60) * 60, end = Math.floor(current / 60) * 60
  if (start < end) db.prepare('INSERT OR IGNORE INTO journal_gaps(host,start,end,cursor) VALUES(?,?,?,?)').run(host,start,end,start)
}
export function readRemote(host, request) {
  const arg = Buffer.from(JSON.stringify(request)).toString('base64')
  const timeout = request.task === 'directory' ? (request.seconds+20)*1000 : 90000
  const script = ['log-evidence.py','retained-probe.py'].map(n => readFileSync(path.join(pkg,n),'utf8')).join('\n')
  return new Promise((resolve,reject) => {
    const child = execFile('/usr/bin/ssh',['-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oUpdateHostKeys=no',
      '-oConnectTimeout=5','-oClearAllForwardings=yes','-oForwardAgent=no','-oControlPath=none','-T','--',
      host.alias,'python3 -I - ' + arg],{timeout,maxBuffer:65536},(error,stdout) => {
      try { if (error) throw error; resolve(JSON.parse(stdout)) } catch { reject(Error('只读补采未成功')) }
    })
    child.stdin.on('error',()=>{})
    child.stdin.end(script)
  })
}
export async function collectJournal(db,host,read=readRemote) {
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
export async function collectDirectory(db,host,read=readRemote,stamp=now()) {
  const inventory=db.prepare('SELECT body FROM inventories WHERE host=?').get(host.id)
  if (!inventory) return
  const sources=Object.entries(JSON.parse(inventory.body).sources || {}).filter(([p,v])=>
    path.isAbsolute(p) && p!=='/' && !v.temporary_candidate && (v.is_directory ?? v.db_signatures !== null)).map(([p])=>p)
  const last=db.prepare('SELECT MAX(ts) AS ts FROM directory_sizes WHERE host=? AND source=?')
  const next=sources.map(source=>({source,ts:last.get(host.id,source).ts ?? 0})).sort((a,b)=>a.ts-b.ts)[0]
  if (!next || stamp-next.ts<3600) return
  const recentTimeout = db.prepare(
    "SELECT 1 FROM directory_sizes WHERE host=? AND source=? AND ts>=? AND reason='扫描超时' LIMIT 1"
  ).get(host.id,next.source,stamp-7*86400)
  const seconds = recentTimeout ? 180 : 75
  let bytes=null,reason='SSH 或目录不可读'
  try {
    const r=await read(host,{task:'directory',machine:host.machine,source:next.source,seconds})
    if(Number.isSafeInteger(r.bytes) && r.bytes>=0) { bytes=r.bytes;reason=null }
    else reason=r.reason==='timeout'?'扫描超时':'目录不可读'
  } catch {}
  db.prepare('INSERT OR IGNORE INTO directory_sizes VALUES(?,?,?,?,?)').run(host.id,next.source,stamp,bytes,reason)
}
export function directoryStats(db,host) {
  return db.prepare(`WITH ranked AS (SELECT *,row_number() OVER (PARTITION BY source ORDER BY ts DESC) rn
    FROM directory_sizes WHERE host=?) SELECT r.source,r.ts,r.bytes,r.reason,p.ts previous_ts,p.bytes previous_bytes
    FROM ranked r LEFT JOIN directory_sizes p ON p.host=r.host AND p.source=r.source AND p.ts=(
      SELECT max(ts) FROM directory_sizes WHERE host=r.host AND source=r.source AND ts<r.ts AND bytes IS NOT NULL)
    WHERE r.rn=1 ORDER BY (r.bytes-p.bytes) DESC,r.source`).all(host)
}
