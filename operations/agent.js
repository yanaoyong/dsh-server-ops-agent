import { publishFixture, groupFiles, restoreGroup, discoverGroups, reconcileGroups } from './groups.js'
import { collectAppnode, checkDailyOutput, businessFeedback } from './appnode.js'
import { collectJournal, collectDirectory } from './retained.js'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { overview, detail, pendingPlans, appnodeHistory, resourceHistory } from './queries.js'
import { root, socket, mac, testPilot } from './paths.js'
import { createSampler } from './sampling.js'
import {
  openLedger,
  now,
  observe,
  queue,
  reports,
  makePlan,
  decide,
  audit,
  atomic
} from './ledger.js'
import { fixture, recordProbe, execute } from './fixture.js'
import { modelCatalog, selectModel } from './model-routing.js'
import { askOperator, operatorHistory, operatorHost, localRecord } from './operator.js'
import { dispatch, investigate, currentHostObservations } from './model.js'
import {
  auth,
  checkAuthorization,
  storage,
  backup,
  restore,
  recoverIndex,
  claimBackup,
  setBackupSchedule,
  recordBackupFreshness,
  failBackup,
  reconcileBackups
} from './backup.js'
import { createNightWardenWorkbench } from './nightwarden-workbench.js'
import { collectHost } from './ssh.js'
import { googleDrive } from './google-drive.js'

const db = openLedger()
const nightwarden = createNightWardenWorkbench(db)
// Sync the enrolled instance even while the workbench is closed.
let syncingNightwarden=false
const syncNightwarden=async()=>{
  if(syncingNightwarden || !fs.existsSync(path.join(root,'nightwarden.json'))) return
  syncingNightwarden=true
  try {await nightwarden('nw-overview')} catch {} finally {syncingNightwarden=false}
}
setInterval(syncNightwarden,60000).unref()
void syncNightwarden()
const pilot = testPilot ? await fixture(db) : null
let investigating = false,
  archiving = false,
  stopping = false
const ordered = (stmt, ...args) => db.prepare(stmt).all(...args)
async function withCloud(work) {
  if (archiving) throw Error('已有网盘作业进行中')
  archiving = true
  try {
    const store = await storage()
    try {
      return await work(store)
    } finally {
      await store.close()
    }
  } finally {
    archiving = false
  }
}
async function startBackup(scheduled = false) {
  if (archiving) throw Error('已有网盘作业进行中')
  const job = claimBackup(db, now(), scheduled)
  if (!job) return
  try {
    return await withCloud((store) => backup(db, store, undefined, job))
  } catch (e) {
    if (db.prepare("SELECT 1 FROM backups WHERE id=? AND status='running'").get(job))
      failBackup(db, job, '读取恢复材料或网盘失败')
    throw e
  }
}
let checkingAuthorization = false
let reconcileAfter = 0
const pilotCloudActions = new Set(['backup', 'files', 'restore', 'discover'])
async function handle(action, data) {
  if (action.startsWith('google-')) return googleDrive(db,action,data)
  // Older local clients omit host and address the original Mac pilot.
  if (pilotCloudActions.has(action) && (!pilot || (data.host ?? mac) !== mac))
    throw Error('该主机尚未登记云端备份范围')
  if (['auth','authorize','finish-login'].includes(action) && (!pilot || (data.host ?? mac) !== mac)) {
    if (!db.prepare('SELECT 1 FROM inventories i JOIN workbench_hosts h ON h.id=i.host WHERE i.host=?').get(data.host))
      throw Error('该主机尚未登记云端备份范围')
    return auth(action,data.code)
  }
  if (action.startsWith('group-') && !db.prepare('SELECT 1 FROM inventories WHERE host=?').get(data.host))
    throw Error('请选择已盘点的主机')
  if (['nw-overview','nw-event','nw-question','nw-disable','nw-proposal','nw-handoff','nw-workspace-link','nw-workspace-evidence'].includes(action)) return nightwarden(action,data)
  switch (action) {
    case 'agent-models': return modelCatalog(db)
    case 'agent-model': return selectModel(db,data.selection)
    case 'agent-record': {
      const {id:host}=operatorHost(db,data.host)
      const id=typeof data.id==='string' ? data.id.trim().toLowerCase() : ''
      if (!/^(?:duty:)?(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|capacity-[0-9a-f]{32})$/.test(id))
        throw Error('请输入完整的事件或调查编号')
      const record=localRecord(db,host,id) ?? await nightwarden('nw-record',{host,id})
      return record ?? {host,id,found:false,message:'本主机已同步的记录中未找到该编号'}
    }
    case 'agent-observations': {
      const host=operatorHost(db,data.host)
      await sampleHost(host)
      return currentHostObservations(db,host.id)
    }
    case 'agent-ask': return data.topic==='appnode-feedback' ? businessFeedback(db,data) : askOperator(db,data)
    case 'agent-history': return operatorHistory(db,data.host,data.before)
    case 'group-publish':
      return withCloud(store=>publishFixture(db,store,data.host))
    case 'group-files':
      return withCloud(async store=>({files:await groupFiles(db,store,data.host,data.version,data.member)}))
    case 'group-restore':
      return withCloud(store=>restoreGroup(db,store,data.host,data.version,data.member??null,data.file??null))
    case 'group-discover':
      return withCloud(store=>discoverGroups(db,store,data.host))
    case 'overview':
      if (data.section === 'daily-output-check') return checkDailyOutput(db,data.host,data.date)
      if (data.section === 'appnode-history') return appnodeHistory(db, data.host)
      if (data.section === 'resource-history') return resourceHistory(db, data.host, data.resource)
      return data.section === 'count'
        ? { count: pendingPlans(db).length }
        : overview(db)
    case 'event':
      return detail(db, data.id)
    case 'question': {
      if (
        typeof data.question !== 'string' ||
        !data.question.trim() || data.question.length > 600
      )
        throw Error('问题需要 1 至 600 字')
      detail(db, data.id)
      return { qid: atomic(db, () => queue(db, data.id, data.question.trim(), now(), data.parentId)) }
    }
    case 'propose':
      if (!pilot) throw Error('没有适用的固定动作')
      return { plan: atomic(db, () => makePlan(db, data.id)) }
    case 'decide':
      if (!pilot) throw Error('没有适用的固定动作')
      return { status: decide(db, data.id, data.digest, data.choice) }
    case 'auth':
      return checkAuthorization(db)
    case 'finish-login': {
      const result = await auth(action, data.code)
      return checkAuthorization(db, () => result)
    }
    case 'authorize':
      return auth(action)
    case 'schedule-backup':
      if (!pilot || data.host !== mac) throw Error('该主机尚未登记每日备份范围')
      return { policy: setBackupSchedule(db, data.enabled) }
    case 'backup':
      return startBackup()
    case 'files': {
      if (
        !db
          .prepare('SELECT 1 FROM versions WHERE id=? AND host=?')
          .get(data.version, mac)
      )
        throw Error('请选择已发布版本')
      return withCloud(async (store) => ({
        files: (await store.read('version', data.version)).files.map(
          (f) => f.name
        )
      }))
    }
    case 'restore':
      return withCloud((store) =>
        restore(db, store, data.version, undefined, data.file ?? null)
      )
    case 'discover':
      return withCloud((store) => recoverIndex(db, store))
    default:
      throw Error('未知操作')
  }
}
const srv = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/') throw Error('请求无效')
    let text = '', bytes = 0
    req.setEncoding('utf8')
    for await (const part of req) {
      bytes += Buffer.byteLength(part)
      if (bytes > 1024 * 1024) throw Error('单次请求超过 1 MiB，请分段发送')
      text += part
    }
    const { action, data = {} } = JSON.parse(text)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(await handle(action, data)))
  } catch (e) {
    // Local paths and third-party stderr can contain credentials.
    const reason = /^[\u3400-\u9fffA-Za-z0-9 及至，、/]+$/u.test(e.message)
      ? e.message
      : '操作失败，请核对作业或事件记录'
    res.writeHead(400).end(JSON.stringify({ error: reason }))
  }
})
// Supervisor holds an exclusive flock for this process's entire lifetime.
fs.rmSync(socket, { force: true })
await new Promise((resolve, reject) =>
  srv.once('error', reject).listen(socket, resolve)
)
fs.chmodSync(socket, 0o600)
db.prepare(
  "UPDATE investigations SET status='retry',retry=? WHERE status='running'"
).run(now())
db.prepare(
  "UPDATE backups SET status='interrupted',finished=? WHERE status='running'"
).run(now())
db.prepare("UPDATE group_jobs SET status='interrupted' WHERE status='running'").run()
audit(db, null, 'scheduler', '调度已恢复', {})
let nextPoll = 0,
  lastTick = now()
const evidenceWorkers = new Set()
function gatherEvidence(host) {
  const identity = db.prepare('SELECT machine FROM identities WHERE host=?').get(host.id)
  if (!identity) return
  for (const work of [collectJournal, collectDirectory, collectAppnode]) {
    const key = host.id + work.name
    if (evidenceWorkers.has(key)) continue
    evidenceWorkers.add(key)
    work(db,{...host,...identity}).catch(() => console.error('只读补采中断',work.name)).finally(()=>evidenceWorkers.delete(key))
  }
}
const {sample:sampleHost, poll:pollHost} = createSampler({
  collect: host => collectHost(db, host),
  onSuccess: gatherEvidence,
  onFailure: host => observe(db,host.id,'SSH 连接','bad',{reason:'只读采集器中断'})
})
function pollRemote() {
  for (const host of ordered('SELECT h.* FROM workbench_hosts h JOIN enrolled e ON e.host=h.id')) {
    pollHost(host)
  }
}
async function runInvestigation(db,job) {
  const operator = db.prepare('SELECT host FROM operator_questions WHERE job=?').get(job.id)
  if (operator) await sampleHost(operatorHost(db,operator.host))
  return investigate(db,job)
}
async function tick() {
  try {
    if (now() - lastTick > 65)
      audit(db, null, 'scheduler', '调度已恢复', { gap: [lastTick, now()] })
    lastTick = now()
    if (pilot) await execute(db, pilot.probe)
    const expired = ordered(
      "SELECT id,incident FROM plans WHERE status='pending' AND json_extract(body,'$.expires')<=?",
      now()
    )
    for (const p of expired)
      atomic(db, () => {
        db.prepare("UPDATE plans SET status='expired' WHERE id=?").run(p.id)
        audit(db, p.incident, 'controller', 'expired', { plan: p.id })
      })
    if (now() >= nextPoll) {
      nextPoll = now() + 30
      const id = pilot && recordProbe(db, await pilot.probe())
      if (
        id &&
        !db.prepare('SELECT 1 FROM plans WHERE incident=?').get(id) &&
        !db.prepare('SELECT closed FROM cases WHERE id=?').get(id).closed
      )
        makePlan(db, id)
      pollRemote()
      const interrupted = db
        .prepare("SELECT 1 FROM backups WHERE status='interrupted' LIMIT 1")
        .get()
      const groupInterrupted = db.prepare("SELECT 1 FROM group_jobs WHERE status='interrupted' AND json_extract(body,'$.operation')='测试组备份' LIMIT 1").get()
      if (((pilot && interrupted) || groupInterrupted) && !archiving && now() >= reconcileAfter) {
        reconcileAfter = now() + 300
        withCloud(async store => {
          try { if (pilot) await reconcileBackups(db,store) }
          finally { await reconcileGroups(db,store) }
        }).catch(() => {})
      }
      const policy = pilot && db
        .prepare('SELECT due FROM schedule WHERE host=?')
        .get(mac)
      const protectedFiles = policy ||
        db.prepare('SELECT 1 FROM versions WHERE host=? LIMIT 1').get(mac)
      if (pilot && protectedFiles && !checkingAuthorization) {
        const last = db.prepare("SELECT MAX(ts) AS ts FROM samples WHERE host=? AND signal='网盘授权'").get(mac)
        if (now() - (last.ts ?? 0) >= 3600) {
          checkingAuthorization = true
          checkAuthorization(db)
            .catch(() => {})
            .finally(() => { checkingAuthorization = false })
        }
      }
      if (policy && !interrupted && policy.due <= now() && !archiving) {
        startBackup(true).catch(() => {})
      }
      if (policy) recordBackupFreshness(db, policy)
      reports(db)
    }
    if (!investigating) {
      investigating = true
      dispatch(db,runInvestigation)
        .catch(() => {})
        .finally(() => {
          investigating = false
        })
    }
  } catch (e) {
    console.error('值班循环异常', e.code ?? e.name)
  }
  if (!stopping) setTimeout(tick, 2000)
}
tick()
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true
    srv.close()
    pilot?.close()
    process.exit()
  })
