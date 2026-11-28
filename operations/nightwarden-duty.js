import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createNightwardenPolicy } from './nightwarden-policy.js'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const exec = promisify(execFile)
const DAY = 86400
const CAPACITY = '/srv/appnode'
const directorySnapshot = '/opt/dsh-nightwarden/metrics/directories.json'
const capacityGuide =
  '只读核对本主机及挂载的 node_filesystem_avail_bytes、node_filesystem_size_bytes。' +
  '一级目录按 dsh_directory_allocated_bytes 排序，并查看 dsh_directory_sample_timestamp_seconds。' +
  'du 每小时最多一次，指标每 30 秒重发。重复的采样时间只算一次，查询窗口长度不能充当观测历史。' +
  '只有同一路径、设备和 inode 的两个独立采样才可判断增长、下降或持平。' +
  '首次采样后缺少 dsh_directory_previous_sample_timestamp_seconds 和 dsh_directory_change_bytes 属正常。' +
  '单个样本只报告当时占用与采样时间，写明目录增长未知。文件系统可用量不能证明具体目录增长。' +
  '判断采集器状态还需核对最近的实际采集尝试、结果和小时周期。清理用户数据由用户决定。'
const iso = seconds => new Date(seconds * 1000).toISOString()
const nowSeconds = () => Math.floor(Date.now() / 1000)
// 07:00 in Asia/Shanghai is 23:00 UTC the previous day.
const cutoff = seconds => Math.floor((seconds + 3600) / DAY) * DAY - 3600
const key = (...fields) => createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 32)

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function endpoint(value, local = false) {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(local && loopback && url.protocol === 'http:'))) {
    throw Error('需要受控 HTTPS 地址；本机回环允许 HTTP')
  }
  return url
}

export function validateDuty(config) {
  const {host, container, interval = 60, dbPath, probeUrl, nightwardenUrl, notifyUrl} = config
  if (![host,container].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$/.test(value))) throw Error('主机或容器标识无效')
  if (!Number.isInteger(interval) || interval < 15 || interval > 300 || 3600 % interval) throw Error('采样周期应为能整除一小时的 15 至 300 秒整数')
  if (!path.isAbsolute(dbPath)) throw Error('dbPath 需要绝对路径')
  if (config.capacityPct != null && (!Number.isFinite(config.capacityPct) || config.capacityPct <= 0 || config.capacityPct > 100)) throw Error('容量阈值需要在 0 至 100 之间')
  const startupGraceMs = config.startupGraceMs ?? 2000
  if (!Number.isInteger(startupGraceMs) || startupGraceMs < 0 || startupGraceMs > 10000) {
    throw Error('容器启动宽限须为 0 至 10000 毫秒的整数')
  }
  if (config.containerId != null && !/^[0-9a-f]{64}$/.test(config.containerId)) throw Error('containerId 必须为完整 Docker ID')
  endpoint(probeUrl, true)
  if (nightwardenUrl) endpoint(nightwardenUrl, true)
  if (notifyUrl) endpoint(notifyUrl)
  return {...config, host, container, interval, startupGraceMs}
}

export function openDuty(config) {
  fs.mkdirSync(path.dirname(config.dbPath), {recursive:true, mode:0o700})
  const db = new DatabaseSync(config.dbPath)
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS duty_device (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), host TEXT, container TEXT, probe TEXT, interval INTEGER, started INTEGER);
    CREATE TABLE IF NOT EXISTS duty_authority (singleton INTEGER PRIMARY KEY CHECK(singleton=1), container_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS duty_samples (
      slot INTEGER PRIMARY KEY, observed INTEGER NOT NULL, healthy INTEGER, http_status INTEGER,
      device TEXT, total INTEGER, free INTEGER, used_pct REAL);
    CREATE TABLE IF NOT EXISTS duty_capacity_active (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT, opened INTEGER);
    CREATE TABLE IF NOT EXISTS duty_journal (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS duty_journal_time ON duty_journal(at);
    CREATE TABLE IF NOT EXISTS duty_outbox (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, channel TEXT NOT NULL, body TEXT NOT NULL,
      created INTEGER NOT NULL, sent INTEGER, attempts INTEGER NOT NULL DEFAULT 0, retry INTEGER NOT NULL DEFAULT 0,
      lease TEXT, last_status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS duty_reports (until INTEGER PRIMARY KEY, generated INTEGER NOT NULL, body TEXT NOT NULL);
  `)
  const device = db.prepare('SELECT * FROM duty_device').get()
  if (device && (device.host !== config.host || device.container !== config.container || device.probe !== config.probeUrl || device.interval !== config.interval)) {
    db.close()
    throw Error('既有账本绑定的主机、容器、探针和周期需一致')
  }
  return db
}

export async function measure(config, fetcher=fetch) {
  let healthy = false, status = null
  try {
    const response = await fetcher(config.probeUrl, {redirect:'manual', signal:AbortSignal.timeout(5000)})
    status = response.status
    healthy = response.ok
    await response.body?.cancel()
  } catch { /* connection failure is a failed business probe */ }
  return {healthy, status, ...measureCapacity()}
}

function measureCapacity() {
  let capacity = {}
  try {
    const {dev} = fs.statSync(CAPACITY)
    const {bsize, blocks, bavail, bfree} = fs.statfsSync(CAPACITY)
    capacity = {device:String(dev), total:bsize * blocks, free:bsize * bavail, usedPct:100*(blocks-bfree)/(blocks-bfree+bavail)}
  } catch { /* unavailable filesystem is recorded as unknown */ }
  return capacity
}

// Individual directory timestamps are the du observation times, not scrape or delivery times.
export function capacityDirectoryFacts(snapshot, mount, at) {
  const observedAt=snapshot?.attempt
  if (snapshot?.status!=='ok' || !Number.isSafeInteger(observedAt) || observedAt<=0 ||
      !Number.isSafeInteger(snapshot.completed) || snapshot.completed<observedAt || snapshot.completed>at ||
      !snapshot.rows || typeof snapshot.rows!=='object') return null
  const device=String(fs.statSync(mount,{bigint:true}).dev)
  const point=p=>Array.isArray(p) && p.length===2 && p.every(Number.isSafeInteger) && p[0]>0 && p[1]>=0
  const directories=[]
  for (const [key,row] of Object.entries(snapshot.rows)) {
    if (!row || typeof row.path!=='string' || path.dirname(row.path)!==mount || path.resolve(row.path)!==row.path ||
        /[\x00-\x1f\x7f]/.test(row.path) || row.device!==device || key!==device+':'+row.inode+':'+row.path ||
        !Array.isArray(row.points) || ![1,2].includes(row.points.length) || !row.points.every(point)) continue
    const last=row.points.at(-1)
    if (last[0]!==observedAt) continue
    let current
    try { current=fs.lstatSync(row.path,{bigint:true}) } catch { continue }
    if (!current.isDirectory() || String(current.dev)!==device || String(current.ino)!==row.inode) continue
    const dir={path:row.path,bytes:last[1]}
    const previous=row.points.length===2 ? row.points[0] : null
    if (previous && previous[0]<observedAt) {
      dir.previousAt=previous[0]
      dir.previousBytes=previous[1]
    }
    directories.push(dir)
  }
  directories.sort((a,b)=>b.bytes-a.bytes || a.path.localeCompare(b.path))
  return directories.length ? {observedAt,directories:directories.slice(0,30)} : null
}

function capacityAnnotations(summary, at) {
  const annotations={summary,description:capacityGuide}
  try {
    if (fs.statSync(directorySnapshot).size<=2*1024*1024) {
      const facts=capacityDirectoryFacts(JSON.parse(fs.readFileSync(directorySnapshot,'utf8')),CAPACITY,at)
      if (facts) annotations.dsh_directory_facts=JSON.stringify(facts)
    }
  } catch { /* A missing scan never suppresses a valid filesystem alert. */ }
  return annotations
}

function alertPayload(config, eventId, start, at, phase, detail) {
  const status = phase === 'resolved' ? 'resolved' : 'firing'
  const labels = {instance:config.host, dsh_event_id:eventId}
  const capacity=eventId.startsWith('capacity-')
  if (capacity) Object.assign(labels,{alertname:'DSHFilesystemCapacity',mountpoint:CAPACITY})
  else Object.assign(labels,{alertname:'DSHBusinessProbe',container:config.container})
  const alert = {status, labels, annotations:capacity ? capacityAnnotations(detail,at) : {summary:detail},
    fingerprint:eventId, startsAt:iso(start)}
  if (status === 'resolved') alert.endsAt = iso(at)
  return {version:'4', status, groupKey:eventId, groupLabels:labels, alerts:[alert]}
}

// A transition and its outgoing messages commit together. Retries use the original event and delivery IDs.
function append(db, config, eventId, start, at, kind, detail) {
  const id = key(eventId, kind)
  if (!db.prepare('INSERT OR IGNORE INTO duty_journal VALUES (?,?,?,?,?)').run(id, eventId, at, kind, detail).changes) return
  const add = db.prepare('INSERT OR IGNORE INTO duty_outbox(id,event_id,channel,body,created) VALUES (?,?,?,?,?)')
  if (kind === 'firing' || kind === 'resolved') {
    add.run(key(id,'nightwarden'), eventId, 'nightwarden', JSON.stringify(alertPayload(config, eventId, start, at, kind, detail)), at)
  }
  if (kind === 'escalated') {
    const idempotencyKey = key(id,'notify')
    add.run(idempotencyKey, eventId, 'notify', JSON.stringify({id:idempotencyKey, host:config.host, container:config.container, eventId, at:iso(at), reason:detail}), at)
  }
}

export async function deliver(db, config, at, fetcher=fetch, capacityOnly=false) {
  const scope = capacityOnly ? " AND event_id GLOB 'capacity-*'" : ''
  // Reserve a bounded number of sends per channel. A disconnected investigation service
  // cannot prevent the independent escalation channel from reaching the operator.
  const pending = db.prepare(`SELECT * FROM duty_outbox o WHERE channel=? AND sent IS NULL AND retry<=? ${scope}
    AND NOT EXISTS(SELECT 1 FROM duty_outbox earlier WHERE earlier.event_id=o.event_id AND earlier.channel=o.channel
        AND earlier.rowid<o.rowid AND earlier.sent IS NULL) ORDER BY rowid LIMIT 8`)
  const tasks = []
  for (const channel of ['notify','nightwarden']) {
    const isAlert = channel === 'nightwarden'
    const url = isAlert ? config.nightwardenUrl : config.notifyUrl
    const token = process.env[isAlert ? 'NW_ALERT_TOKEN' : 'NW_NOTIFY_TOKEN']
    if (!url || (isAlert && !token)) {
      db.prepare("UPDATE duty_outbox SET last_status='awaiting_configuration' WHERE channel=? AND sent IS NULL AND last_status!='awaiting_configuration'"+scope).run(channel)
      continue
    }
    for (const row of pending.all(channel,at)) tasks.push(send(row,url,token,isAlert))
  }
  await Promise.all(tasks)
  async function send(row,url,token,isAlert) {
    const lease = randomUUID()
    if (!db.prepare('UPDATE duty_outbox SET lease=?, retry=?, attempts=attempts+1 WHERE id=? AND sent IS NULL AND retry<=?').run(lease,at+60,row.id,at).changes) return
    let outcome = 'transport_error', ok = false
    try {
      const headers = {'Content-Type':'application/json','Idempotency-Key':row.id}
      if (token) headers.Authorization = 'Bearer ' + token
      const response = await fetcher(url, {method:'POST', redirect:'error', headers, body:row.body, signal:AbortSignal.timeout(5000)})
      outcome = 'http_' + response.status
      if (isAlert && response.ok) {
        const receipt = await response.json()
        ok = Number.isInteger(receipt.received) && Number.isInteger(receipt.stored) && Number.isInteger(receipt.skipped)
        if (!ok) outcome = 'invalid_ingest_receipt'
      } else {
        ok = response.ok
        await response.body?.cancel()
      }
    } catch { /* avoid emitting destination URLs, response bodies, or credentials */ }
    db.prepare('UPDATE duty_outbox SET sent=?,retry=?,lease=NULL,last_status=? WHERE id=? AND lease=?')
      .run(ok ? at : null, at + Math.min(1800, 15 * 2 ** Math.min(row.attempts, 7)),outcome,row.id,lease)
  }
}

function missingRanges(samples, start, end, interval, capacityFrom=Infinity) {
  const ranges = []
  let covered = start
  for (const row of samples) {
    if (row.slot >= capacityFrom ? row.device === null : row.healthy === null) continue
    const slot = Math.max(start,row.slot)
    if (slot > covered) ranges.push({from:covered, until:slot})
    covered = Math.max(covered, Math.min(end,row.slot + interval))
  }
  if (covered < end) ranges.push({from:covered,until:end})
  return ranges
}

function capacityFacts(samples) {
  const valid = samples.filter(row => row.device !== null && row.total > 0)
  const latest = valid.at(-1)
  if (!latest) return {path:CAPACITY, scope:'filesystem_available_bytes', available:null}
  const previous = valid.slice(0,-1).reverse().find(row => row.device===latest.device && row.total===latest.total && row.observed<latest.observed)
  return {path:CAPACITY, scope:'filesystem_available_bytes', at:latest.observed, available:latest.free, total:latest.total,
    usedPct:latest.used_pct, previousAt:previous?.observed ?? null, availableChange:previous ? latest.free-previous.free : null}
}

function reportsDue(db, config, at, capacityFrom) {
  const first = db.prepare('SELECT started FROM duty_device').get().started
  const last = db.prepare('SELECT max(until) AS t FROM duty_reports').get().t ?? cutoff(first)
  for (let end = last + DAY; end <= cutoff(at); end += DAY) {
    const start = end - DAY
    const samples = db.prepare('SELECT * FROM duty_samples WHERE slot>=? AND slot<? ORDER BY slot').all(start,end)
    const events = db.prepare(`SELECT j.* FROM duty_journal j WHERE j.at<? AND (
      j.event_id IN (SELECT event_id FROM duty_journal WHERE at>=? AND at<?)
      OR NOT EXISTS(SELECT 1 FROM duty_journal r WHERE r.event_id=j.event_id AND r.kind='resolved' AND r.at<?))
      ORDER BY j.at,j.rowid`).all(end,start,end,end)
    const pending = new Set(), decided = new Set(), recovered = new Set()
    for (const {event_id:id,kind} of events) {
      if (kind==='escalated') pending.add(id)
      if (kind==='handoff_approved' || kind==='handoff_rejected') decided.add(id)
      if (kind==='resolved') recovered.add(id)
    }
    const snapshot = {id:key(config.host,end), host:config.host, from:start, until:end, timezone:'Asia/Shanghai', generated:at,
      events, autoRecovered:[...new Set(events.filter(row=>row.kind==='auto_recovered' && row.at>=start).map(row=>row.event_id))],
      awaitingDecision:[...pending].filter(id=>!decided.has(id) && !recovered.has(id)),
      awaitingRecovery:[...decided].filter(id=>!recovered.has(id)),
      missing:missingRanges(samples,start,end,config.interval,capacityFrom), capacity:capacityFacts(samples)}
    db.prepare('INSERT OR IGNORE INTO duty_reports VALUES (?,?,?)').run(end,at,JSON.stringify(snapshot))
  }
}

function recordPolicy(db,config,event) {
  if (!event) return
  const fired = event.samples.at(-1).observedAt
  append(db,config,event.id,event.opened,fired,'firing','业务探测失败，已立案调查')
  if (event.status === 'claimed') return
  if (event.execution_id) append(db,config,event.id,event.opened,event.claimed_at,'attempt',event.execution_id)
  if (event.status === 'recovered') {
    append(db,config,event.id,event.opened,event.verified_at,'auto_recovered','固定动作后业务复查通过')
    append(db,config,event.id,event.opened,event.verified_at,'resolved','业务复查通过')
  } else {
    const notice = db.prepare('SELECT created FROM nw_policy_notices WHERE event_id=?').get(event.id)
    if (notice) append(db,config,event.id,event.opened,notice.created,'escalated',event.reason)
    if (event.observed_recovery != null) append(db,config,event.id,event.opened,event.observed_recovery,'resolved','后续业务采样恢复')
  }
}

function recordCapacity(db,config,row) {
  if (row.used_pct == null) return
  const active = db.prepare('SELECT * FROM duty_capacity_active').get()
  if (row.used_pct < (config.capacityPct ?? 85)) {
    if (active) {
      append(db,config,active.id,active.opened,row.observed,'resolved','文件系统占用已回到阈值以下')
      db.exec('DELETE FROM duty_capacity_active')
    }
  } else if (!active) {
    const id = 'capacity-' + key(config.host,CAPACITY,row.observed)
    db.prepare('INSERT INTO duty_capacity_active VALUES(1,?,?)').run(id,row.observed)
    append(db,config,id,row.observed,row.observed,'firing',CAPACITY+' 所在文件系统占用 '+row.used_pct.toFixed(1)+'%，需只读调查')
  }
}

function restartAllowed(config) {
  return /^[a-f0-9]{64}$/.test(config.containerId ?? '') && ['localhost','127.0.0.1','[::1]'].includes(new URL(config.probeUrl).hostname)
}

async function restartContainer(config,signal) {
  if (!restartAllowed(config)) return 'unknown'
  const format = '{{.Id}} {{.Name}} {{index .Config.Labels "io.dsh.nightwarden.rehearsal"}}'
  const {stdout} = await exec('docker',['inspect','--type','container','--format',format,config.containerId],{signal,timeout:6000})
  if (stdout.trim() !== config.containerId+' /'+config.container+' true') return 'unknown'
  await exec('docker',['restart','--time','8',config.containerId],{signal,timeout:20000})
  return 'restarted'
}

export function dutyService(db,config,options={}) {
  const clock = options.clock ?? nowSeconds
  const collect = options.measure ?? (()=>measure(config))
  const policy = createNightwardenPolicy(db,{
    ruleId:'dsh-rehearsal-'+key(config.host,config.container,config.probeUrl), host:config.host, container:config.container,probeId:'business-http',
    now:clock,maxSampleAgeSeconds:3*config.interval, restart:options.restart ?? ((target,id,signal)=>{
      if (db.prepare('SELECT container_id FROM duty_authority WHERE singleton=1').get()?.container_id !== config.containerId) return 'unknown'
      return restartContainer(config,signal)
    }),
    probe:options.recheck ?? (async(_target,_executionId,signal)=>{
      // Docker acknowledges process startup before the service listens on its business port.
      await delay(config.startupGraceMs ?? 2000, undefined, {signal})
      const value=await collect()
      return value.healthy===true?'ok':value.healthy===false?'bad':'unknown'
    })
  })
  function syncPolicy(events) {
    transaction(db,()=>{for (const event of events) recordPolicy(db,config,event)})
  }
  // Recover committed policy receipts when a previous process exited before creating the outbox.
  policy.reconcileInterrupted()
  syncPolicy(policy.events())

  async function tick() {
    const at = clock()
    let slot = at - at % config.interval
    let sample = db.prepare('SELECT * FROM duty_samples WHERE slot=?').get(slot)
    if (!sample) {
      const result = await collect()
      const observed = clock()
      slot = observed - observed % config.interval
      transaction(db,()=>{
        db.prepare('INSERT OR IGNORE INTO duty_device VALUES (1,?,?,?,?,?)').run(config.host,config.container,config.probeUrl,config.interval,at)
        db.prepare('INSERT OR IGNORE INTO duty_samples VALUES (?,?,?,?,?,?,?,?)').run(slot,observed,result.healthy==null?null:Number(result.healthy),result.status ?? null,
          result.device ?? null,result.total ?? null,result.free ?? null,Number.isFinite(result.usedPct)?result.usedPct:null)
        sample = db.prepare('SELECT * FROM duty_samples WHERE slot=?').get(slot)
        recordCapacity(db,config,sample)
      })
    }
    syncPolicy(policy.reconcileInterrupted())
    const result = await policy.observe({host:config.host,container:config.container,probeId:'business-http',
      sequence:slot/config.interval,observedAt:sample.observed,state:sample.healthy===null?'unknown':sample.healthy?'ok':'bad'})
    if (result.event) syncPolicy([result.event])
    transaction(db,()=>reportsDue(db,config,clock()))
    await deliver(db,config,clock(),options.fetcher)
    for (const event of policy.notifications()) {
      if (db.prepare("SELECT 1 FROM duty_outbox WHERE event_id=? AND channel='notify' AND sent IS NOT NULL").get(event.id)) policy.acknowledgeNotification(event.id)
    }
  }
  return {tick,policy}
}

export function readDuty(db) {
  const device = db.prepare('SELECT host,container,interval,started FROM duty_device').get() ?? null
  const rule = db.prepare('SELECT id AS ruleId,host,container,probe_id AS probeId,enabled FROM nw_policy_rules LIMIT 1').get()
  const recent = db.prepare('SELECT * FROM (SELECT * FROM duty_samples ORDER BY slot DESC LIMIT 2) ORDER BY slot').all()
  const events = db.prepare('SELECT * FROM duty_journal ORDER BY at,rowid').all()
  const deliveries = db.prepare('SELECT id,event_id AS eventId,channel,created,sent,attempts,last_status AS status FROM duty_outbox ORDER BY rowid').all()
  const reports = db.prepare('SELECT body FROM duty_reports ORDER BY until DESC').all().map(r=>JSON.parse(r.body))
  const cases = db.prepare('SELECT id,opened,updated,status,reason,execution_id,probe_result,observed_recovery,related_event FROM nw_policy_events ORDER BY opened DESC').all()
  return {device,rule:rule ? {...rule,enabled:Boolean(rule.enabled)} : null,lastSample:recent.at(-1) ?? null,
    capacity:capacityFacts(recent),events,cases,deliveries,reports}
}

// Continue the existing capacity journal and report windows after fixture retirement.
export async function capacityTick(db,config,clock=nowSeconds,read=async()=>{
  const mount=async()=>(await exec('findmnt',['-n','-o','UUID','-M',CAPACITY],{timeout:3000})).stdout.trim()
  try {
    if (await mount()===config.mountUuid) {
      const facts=measureCapacity()
      if (await mount()===config.mountUuid) return facts
    }
  } catch { /* A missing or replaced mount is a gap, never a recovery. */ }
  return {}
}) {
  const source=db.prepare('SELECT host,interval FROM duty_device WHERE singleton=1').get()
  if (source?.host!==config.host || source.interval!==config.interval) throw Error('容量账本绑定不符')
  const facts=await read()
  const at=clock(), slot=at-at%config.interval
  transaction(db,()=>{
    db.exec('CREATE TABLE IF NOT EXISTS duty_capacity_mode (singleton INTEGER PRIMARY KEY CHECK(singleton=1), first_slot INTEGER NOT NULL)')
    if (db.prepare('INSERT OR IGNORE INTO duty_samples VALUES(?,?,NULL,NULL,?,?,?,?)').run(slot,at,
      facts.device??null,facts.total??null,facts.free??null,facts.usedPct??null).changes) {
      db.prepare('INSERT OR IGNORE INTO duty_capacity_mode VALUES(1,?)').run(slot)
      recordCapacity(db,config,{observed:at,used_pct:facts.usedPct})
    }
    reportsDue(db,config,at,db.prepare('SELECT first_slot FROM duty_capacity_mode').get()?.first_slot)
  })
  await deliver(db,config,at,fetch,true)
}

async function main() {
  const [command, file] = process.argv.slice(2)
  if (command==='run-capacity' && file) {
    const cfg=JSON.parse(fs.readFileSync(file,'utf8'))
    if (cfg.host!=='example-host' || cfg.capacityPct!==85 || cfg.interval!==60 ||
        !/^[a-f0-9-]{36}$/.test(cfg.mountUuid) || !path.isAbsolute(cfg.dbPath) || !fs.existsSync(cfg.dbPath)) throw Error('容量值班配置不符')
    endpoint(cfg.nightwardenUrl,true)
    const db=new DatabaseSync(cfg.dbPath)
    db.exec('PRAGMA busy_timeout=5000')
    for (;;) {
      await capacityTick(db,cfg)
      await delay(Math.max(20,(Math.floor(nowSeconds()/cfg.interval)+1)*cfg.interval*1000-Date.now()))
    }
  }
  if (!file || !['run','once','read','enable','disable'].includes(command)) throw Error('用法：nightwarden-duty.js run|once|read|enable|disable /path/to/config.json')
  const config = validateDuty(JSON.parse(fs.readFileSync(file,'utf8')))
  if (command==='read') {
    const db = new DatabaseSync(config.dbPath,{readOnly:true})
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN')
      console.log(JSON.stringify(readDuty(db)))
    } finally { db.close() }
    return
  }
  const db = openDuty(config)
  try {
    const service = dutyService(db,config)
    if (command==='enable' || command==='disable') {
      if (command==='enable' && !restartAllowed(config)) throw Error('启用需要固定演练容器 ID 和回环业务探针')
      if (command==='enable') db.prepare('INSERT OR REPLACE INTO duty_authority VALUES(1,?)').run(config.containerId)
      console.log(JSON.stringify(service.policy.setEnabled(command==='enable','uid:'+process.getuid())))
      return
    }
    do {
      await service.tick()
      if (command==='once') return
      const next = (Math.floor(nowSeconds()/config.interval)+1)*config.interval
      // Sleep to the next slot so probe and dispatch time do not accumulate into sampling drift.
      await delay(Math.max(20,next*1000-Date.now()))
    } while (true)
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error.message); process.exitCode=1})
}
