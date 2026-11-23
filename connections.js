import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { endpoint, ServiceUnavailable, SshConnection } from './ssh-client.js'
import { deployOffer, deployRelease } from './deployment.js'
import { serverIdPattern, serviceProtocol } from './connection-protocol.js'

const home = os.homedir()
const dshHome = process.env.DSH_HOME?.trim() || path.join(home, '.dsh')
const expandedDshHome = dshHome === '~' ? home :
  /^[~][/\\]/.test(dshHome) ? path.join(home, dshHome.slice(2)) : path.resolve(dshHome)
const workspaceRoot = path.join(existsSync(expandedDshHome) ? realpathSync(expandedDshHome) : expandedDshHome, 'workspaces', 'server-ops')
let store

export function workspacePath(host, serverId) {
  if (!serverIdPattern.test(serverId)) throw Error('服务器标识无效')
  return path.join(workspaceRoot, serverId)
}

export function workspaceTarget(cwd) {
  const key = path.basename(cwd || '')
  if (!serverIdPattern.test(key) || cwd !== workspacePath(null, key)) return null
  const record = store?.state.servers[key]
  return record ? { host: record.host, serverId: key } : null
}

export async function loadConnections(backend) {
  const unit = await backend.kv.open({
    name: 'server_ops_connections', version: 1, tables: [], hasGlobal: true
  })
  let snapshot
  try { snapshot = await unit.loadAll() }
  catch (error) { await unit.close(); throw error }
  const instance = {
    state: snapshot.global ?? { active: null, servers: {}, model: null },
    unit,
    clients: new Map(),
    offers: new Map(),
    updates: Promise.resolve()
  }
  store = instance
  return async () => {
    if (store === instance) store = undefined
    for (const client of instance.clients.values()) client.close()
    await instance.updates
    await unit.close()
  }
}

function storage() {
  if (!store) throw Error('DSH 连接存储尚未就绪')
  return store
}

function edit(change, instance = storage()) {
  const updated = instance.updates.then(async () => {
    const next = await change(instance)
    if (store !== instance) throw Error('DSH 连接存储已关闭')
    if (next !== instance.state) {
      await instance.unit.setGlobal(next)
      instance.state = next
    }
    return instance.state
  })
  instance.updates = updated.catch(() => {})
  return updated
}

function status() {
  const { state } = storage()
  return {
    active: state.active,
    servers: Object.values(state.servers).map(({ serverId, host, config, lastConnectedAt, lastSyncedAt }) => ({
      serverId, host, endpoint: config.host, port: config.port,
      lastConnectedAt: lastConnectedAt ?? null, lastSyncedAt: lastSyncedAt ?? null
    }))
  }
}

function info(reply) {
  if (reply?.protocol !== serviceProtocol || !serverIdPattern.test(reply.serverId) ||
      typeof reply.host !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(reply.host) ||
      typeof reply.version !== 'string' || !Array.isArray(reply.capabilities))
    throw Error('Linux 运维服务协议版本不兼容')
  return reply
}

export async function connectionAction(action, data) {
  if (action === 'connection-status') return status()
  if (action === 'connection-select') {
    await edit(({ state }) => {
      if (!serverIdPattern.test(data.serverId) || !Object.hasOwn(state.servers, data.serverId))
        throw Error('请选择已登记服务器')
      return { ...state, active: data.serverId }
    })
    return status()
  }
  const instance = storage()
  const confirming = action === 'connection-deploy'
  if (action !== 'connection-add' && !confirming) throw Error('连接操作无效')
  const offer = confirming && instance.offers.get(data.confirmation)
  if (confirming) {
    instance.offers.delete(data.confirmation)
    if (!offer || offer.expires <= Date.now()) throw Error('部署确认已失效，请重新验证 SSH')
  }
  const config = confirming ? offer.config : endpoint(data)
  let client = new SshConnection(config)
  let registered = false
  try {
    if (confirming) {
      await deployRelease(client, offer.grantOnly)
      client.close()
      client = new SshConnection(config)
    }
    let reply
    try {
      reply = info(await client.request('service-info'))
    } catch (error) {
      if (confirming || !(error instanceof ServiceUnavailable)) throw error
      return await deployOffer(client, config, instance.offers, error.grantOnly)
    }
    await edit(({ state }) => {
      const prior = state.servers[reply.serverId]
      if (prior && (prior.host !== reply.host || prior.config.host.toLowerCase() !== config.host.toLowerCase() ||
          prior.config.port !== config.port || prior.config.fingerprint !== config.fingerprint))
        throw Error('此服务器标识已绑定其他 SSH 地址或指纹，请核对服务器身份')
      const record = { serverId: reply.serverId, config, host: reply.host,
        lastConnectedAt: client.lastConnectedAt, lastSyncedAt: prior?.lastSyncedAt ?? null }
      return { ...state, active: reply.serverId, servers: { ...state.servers, [reply.serverId]: record } }
    }, instance)
    const { clients } = instance
    clients.get(reply.serverId)?.close()
    clients.set(reply.serverId, client)
    registered = true
    return status()
  } finally {
    if (!registered) client.close()
  }
}

function verifyService(client, record) {
  // Validate the service identity through the pinned SSH connection on each new transport.
  if (!client.verified) {
    client.verified = client.request('service-info').then(reported => {
      const remote = info(reported)
      if (remote.serverId !== record.serverId || remote.host !== record.host) throw Error('服务器身份与登记信息不符')
      client.client?.once('close', () => { client.verified = null })
    }).catch(error => {
      client.verified = null
      throw error
    })
  }
  return client.verified
}

async function saveActivity(instance, serverId, client, syncedAt = null) {
  const record = instance.state.servers[serverId]
  if (!syncedAt && (!client.lastConnectedAt || client.lastConnectedAt <= (record.lastConnectedAt ?? 0)))
    return record
  const stored = await edit(({ state, clients }) => {
    const prior = state.servers[serverId]
    if (clients.get(serverId) !== client) return state
    const lastConnectedAt = Math.max(client.lastConnectedAt ?? 0, prior.lastConnectedAt ?? 0) || null
    const lastSyncedAt = Math.max(syncedAt ?? 0, prior.lastSyncedAt ?? 0) || null
    if (prior.lastConnectedAt === lastConnectedAt && prior.lastSyncedAt === lastSyncedAt) return state
    return { ...state, servers: { ...state.servers, [serverId]: { ...prior, lastConnectedAt, lastSyncedAt } } }
  }, instance)
  return stored.servers[serverId]
}

export async function daemon(action, data = {}, serverId) {
  const instance = storage()
  const { state, clients } = instance
  if (!serverIdPattern.test(serverId) || !Object.hasOwn(state.servers, serverId))
    throw Error('请先连接服务器')
  const record = state.servers[serverId]
  if (!clients.has(serverId)) clients.set(serverId, new SshConnection(record.config))
  const client = clients.get(serverId)
  try {
    await verifyService(client, record)
    const result = await client.request(action, { ...data, host: data.host ?? record.host, serverId })
    if (action === 'overview' && !data.section) {
      const service = info(result.service)
      if (service.serverId !== serverId || service.host !== record.host) throw Error('服务器身份与登记信息不符')
      const { lastConnectedAt, lastSyncedAt } = await saveActivity(instance, serverId, client, Math.floor(Date.now() / 1000))
      return { ...result, service: { ...service, lastConnectedAt, lastSyncedAt } }
    }
    await saveActivity(instance, serverId, client)
    return result
  } catch (error) {
    await saveActivity(instance, serverId, client).catch(() => {})
    throw error
  }
}

export async function dshModels(ctx, action, data = {}) {
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')?.currentSelection() ?? null
  const project = ({ id, name }) => ({ id, name })
  const providers = await Promise.all((llm?.listProviders() ?? []).map(async provider => ({
    ...project(provider), models: (await llm.listModels(provider.id).catch(() => [])).map(project)
  })))
  if (action === 'agent-model') {
    const selection = data.selection
    if (selection !== null && !providers.some(p => p.id === selection?.provider && p.models.some(m => m.id === selection?.model)))
      throw Error('请选择有效的供应商与模型')
    await edit(({ state }) => ({
      ...state, model: selection && { provider: selection.provider, model: selection.model }
    }))
    return { selection: storage().state.model }
  }
  return { default: defaultModel, providers, selection: storage().state.model }
}
