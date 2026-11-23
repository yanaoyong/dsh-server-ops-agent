import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { atomic, hash, now, observe, openLedger, reports } from './ledger.js'
import { detail, overview, resourceHistory } from './queries.js'
import { recordSignals } from './signals.js'
import { currentHostObservations } from './model.js'
import { localRecord, operatorHistory } from './operator.js'
import { collectJournal, enqueueGap } from './retained.js'
import { probeHost, readLocal } from './local-probes.js'
import { createSampler } from './sampling.js'
import { sshInterval } from './paths.js'
import { eventIdPattern, maxRequestBytes, maxResponseBytes, serverIdPattern, serviceProtocol } from './connection-protocol.js'

if (process.platform !== 'linux') throw Error('本机巡检服务需要 Linux')
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version
const state = process.env.SERVER_OPS_STATE || '/var/lib/server-ops-agent'
const socket = path.join(process.env.SERVER_OPS_RUNTIME || '/run/server-ops-agent', 'control.sock')
const machineId = readFileSync('/etc/machine-id', 'utf8').trim()
if (!/^[a-fA-F0-9]{32}$/.test(machineId) || /^0+$/.test(machineId)) throw Error('Linux 机器身份无效')
const machine = hash(machineId)
const configuredHost = process.env.SERVER_OPS_HOST_ID
const defaultHost = hostname().toLowerCase().split('.')[0]
const validHost = id => /^[a-z0-9][a-z0-9-]{0,62}$/.test(id)
const port = Number(process.env.SERVER_OPS_SSH_PORT ?? 22)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('本机 SSH 端口无效')
if (configuredHost !== undefined && !validHost(configuredHost)) throw Error('本机主机编号无效')

const db = openLedger(state)
const host = atomic(db, () => {
  const hosts = db.prepare('SELECT h.id,i.machine FROM hosts h LEFT JOIN identities i ON i.host=h.id').all()
  const existing = hosts[0]
  if (hosts.length > 1 || existing && (existing.machine !== machine || configuredHost && configuredHost !== existing.id))
    throw Error('账本与本机身份不一致')
  db.exec('CREATE TABLE IF NOT EXISTS linux_service_identity (slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL)')
  const saved = db.prepare('SELECT id FROM linux_service_identity WHERE slot=1').get()
  // Keep existing DSH workspaces linked when updating a ledger from alpha.1.
  const serverId = saved?.id ?? (existing ? hash('server-ops-agent:' + machine) : randomBytes(32).toString('hex'))
  if (!serverIdPattern.test(serverId)) throw Error('账本中的服务器标识无效')
  const id = existing?.id ?? configuredHost ?? (validHost(defaultHost) ? defaultHost : 'linux-' + serverId.slice(0, 12))
  db.prepare('INSERT OR IGNORE INTO linux_service_identity VALUES(1,?)').run(serverId)
  db.prepare('INSERT OR IGNORE INTO hosts VALUES(?,?,NULL)').run(id, now())
  db.prepare('INSERT OR IGNORE INTO identities VALUES(?,?)').run(id, machine)
  db.prepare('INSERT OR IGNORE INTO enrolled VALUES(?)').run(id)
  return { id, machine, serverId }
})
const { serverId } = host
const collector = '本机采集'
const latest = db.prepare('SELECT ts,state FROM samples WHERE host=? AND signal=? ORDER BY ts DESC,id DESC LIMIT 1')
const cancellation = new AbortController()
const sampler = createSampler({
  lastSample: () => latest.get(host.id, collector)?.ts ?? 0,
  async collect() {
    const ts = now()
    const result = await probeHost(host, cancellation.signal)
    if (result.identity !== host.machine || !result.signals?.['主机容量']) throw Error('本机探针身份无效')
    atomic(db, () => {
      const previous = latest.get(host.id, collector)
      if (previous && (previous.state !== 'ok' || ts - previous.ts > 2 * sshInterval + 5)) {
        const lastGood = db.prepare("SELECT max(ts) AS ts FROM samples WHERE host=? AND signal=? AND state='ok'").get(host.id, collector).ts
        if (lastGood) enqueueGap(db, host.id, lastGood, ts)
      }
      observe(db, host.id, collector, 'ok', { source: 'linux' }, ts)
      recordSignals(db, host.id, result.signals, ts, { investigate: false })
    })
    await collectJournal(db, host, (target, request) => readLocal(target, request, cancellation.signal))
    return true
  },
  onFailure() {
    if (!cancellation.signal.aborted) {
      observe(db, host.id, collector, 'bad', { reason: '本机探针未完成' }, now(), { investigate: false })
      console.error('本机探针未完成')
    }
  }
})

function serviceInfo() {
  return {
    protocol: serviceProtocol, version, serverId, host: host.id,
    capabilities: ['samples', 'reports', 'events', 'workspace'],
    latestSample: latest.get(host.id, '主机容量')?.ts ?? null
  }
}

function handle(action, data) {
  if (data.serverId !== undefined && data.serverId !== serverId) throw Error('服务器身份与登记信息不符')
  if (data.host !== undefined && data.host !== host.id) throw Error('请求的主机与本机不一致')
  if (action === 'service-info') return serviceInfo()
  if (action === 'overview') {
    if (data.section === 'resource-history') return resourceHistory(db, host.id, data.resource)
    if (data.section !== undefined) throw Error('此服务器未启用该查询')
    return { ...overview(db), service: serviceInfo() }
  }
  if (action === 'event' && eventIdPattern.test(data.id)) return detail(db, data.id)
  if (action === 'agent-history' && (data.before === undefined || eventIdPattern.test(data.before)))
    return operatorHistory(db, host.id, data.before)
  if (action === 'agent-observations') return currentHostObservations(db, host.id)
  if (action === 'agent-record' && typeof data.id === 'string' && eventIdPattern.test(data.id.toLowerCase())) {
    const id = data.id.toLowerCase()
    return localRecord(db, host.id, id) ?? { host: host.id, id, found: false, message: '本机账本中未找到该编号' }
  }
  throw Error('此服务器未启用该操作')
}

const server = createServer(async (req, res) => {
  let status = 200, body
  try {
    if (req.method !== 'POST' || req.url !== '/') throw Error('请求无效')
    const parts = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > maxRequestBytes) throw Error('请求超过大小上限')
      parts.push(chunk)
    }
    const { action, data = {} } = JSON.parse(Buffer.concat(parts))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('请求无效')
    body = JSON.stringify(handle(action, data))
    if (Buffer.byteLength(body) > maxResponseBytes) throw Error('结果超过大小上限')
  } catch (error) {
    status = 400
    const message = /^[\u3400-\u9fffA-Za-z0-9 ]+$/u.test(error.message) ? error.message : '请求处理失败'
    body = JSON.stringify({ error: message })
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(body)
})

// The systemd unit holds the state-directory lock until the process exits.
rmSync(socket, { force: true })
await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve))
chmodSync(socket, 0o660)

let nextReport = 0
function tick() {
  const ts = now()
  if (ts >= nextReport && !sampler.pending(host)) {
    nextReport = ts + 15
    try {
      reports(db, ts, sshInterval, collector)
    } catch (error) {
      console.error('日报生成失败', error.code ?? error.name)
    }
  }
  sampler.poll(host)
}
const timer = setInterval(tick, 1000)
tick()

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  clearInterval(timer)
  cancellation.abort()
  server.close()
  server.closeAllConnections()
  // An interrupted probe writes nothing. SQLite rolls back incomplete transactions.
  process.exit(0)
})
