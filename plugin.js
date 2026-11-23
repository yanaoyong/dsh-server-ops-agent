import {prepareWorkspace,preset} from './native-workspace.js'
import {connectionAction, daemon, dshModels, loadConnections, workspacePath} from './connections.js'
import {maxRequestBytes} from './connection-protocol.js'
const actions = new Set(['overview', 'event', 'agent-history'])
function matchesWorkbench(req) {
  const { origin, host, 'x-server-ops': client } = req.headers
  if (client === 'desktop') {
    // Electron verifies dsh-app://app and removes Origin before proxying HTTP.
    return Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1' &&
      origin === undefined && /^127\.0\.0\.1:\d+$/.test(host)
  }
  return client === '1' && origin === (req.socket.encrypted ? 'https://' : 'http://') + host
}
function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }).end(JSON.stringify(body))
}
export const name = 'server-operations'
export function apply(ctx) {
  ctx.inject(['storage.backend.json'], services => {
    const loading = loadConnections(services.get('storage.backend.json'))
    loading.catch(error => console.error('服务器运维连接存储加载失败', error.code ?? error.name))
    return () => loading.then(dispose => dispose(), () => {})
  })
  const preparing=new Map()
  const polls=new Map()
  let workspaceServices
  function syncWorkspace(host, serverId) {
    const key = serverId ?? host
    if(preparing.has(key)) return preparing.get(key)
    const services=workspaceServices
    const task=prepareWorkspace(services,host,serverId).then(result=>{
      if(result.pendingImport && workspaceServices===services && !polls.has(key)) {
        const tick=()=>{
          polls.delete(key)
          if(workspaceServices===services) syncWorkspace(host,serverId).catch(()=>{
            if(workspaceServices===services) polls.set(key,setTimeout(tick,60000))
          })
        }
        polls.set(key,setTimeout(tick,30000))
      }
      return result
    }).finally(()=>preparing.delete(key))
    preparing.set(key,task)
    return task
  }
  ctx.inject(['workspaceRegistry','agents','agentPresets','sessionPersistence','sessionTitle','sessions'], services=>{
    workspaceServices=services
    return ()=>{
      for(const timer of polls.values()) clearTimeout(timer)
      polls.clear()
      if(workspaceServices===services) workspaceServices=undefined
    }
  })
  ctx.inject(['webServer', 'connection'], (app) => {
    app.effect(
      () =>
        app.webServer.register({
          kind: 'exact',
          path: '/server-operations/api',
          async handler(req, res) {
            try {
              const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
                req.socket.remoteAddress
              )
              const actor = app.connection.admit(req)?.peer
              if (
                !local ||
                !actor ||
                actor !== app.connection.browserPeer ||
                req.method !== 'POST' ||
                req.headers['content-type'] !== 'application/json' ||
                req.headers['sec-fetch-site'] === 'cross-site' ||
                !matchesWorkbench(req)
              ) {
                res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
                  .end(JSON.stringify({ error: 'DSH 未能验证此工作台连接，请重新打开「服务器运维」。' }))
                return
              }
              let body = '', bytes = 0
              req.setEncoding('utf8')
              for await (const chunk of req) {
                bytes += Buffer.byteLength(chunk)
                if (bytes > maxRequestBytes) {
                  res.writeHead(413, {'content-type':'application/json'}).end(JSON.stringify({error:'单次请求超过 1 MiB，请分段发送'}))
                  return
                }
                body += chunk
              }
              const { action, data = {}, serverId } = JSON.parse(body)
              if (typeof action !== 'string' || !data || typeof data !== 'object' || Array.isArray(data)) throw Error('请求无效')
              if (action.startsWith('connection-')) {
                send(res, 200, await connectionAction(action, data))
                return
              }
              if (action === 'agent-models' || action === 'agent-model') {
                send(res, 200, await dshModels(ctx, action, data))
                return
              }
              if (action==='agent-workspace' || action==='agent-workspace-model') {
                try {
                  if(!workspaceServices) throw Error('DSH 会话服务尚未加载')
                  let result
                  if(action==='agent-workspace') {
                    result=await syncWorkspace(data.host,serverId)
                  } else {
                    const agent=workspaceServices.agents.get(data.session)
                    if(!agent || agent.session.header.cwd!==workspacePath(data.host,serverId) || workspaceServices.agentPresets.presetForSession(agent.session)!==preset)
                      throw Error('请重新打开运维会话')
                    const catalog=await dshModels(ctx, 'agent-models')
                    if(catalog.selection) agent.model.select(catalog.selection)
                    result={ok:true}
                  }
                  send(res, 200, result)
                } catch(e) {
                  console.error('server-operations workspace:',e.name,e.message)
                  res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:'运维工作区暂未就绪，请重试'}))
                }
                return
              }
              if (!actions.has(action)) {
                res.writeHead(404).end()
                return
              }
              send(res, 200, await daemon(action, data, serverId))
            } catch (error) {
              const message = /^[\u3400-\u9fffA-Za-z0-9 、，。()·-]{1,180}$/u.test(error.message)
                ? error.message : '服务器运维请求失败'
              if (!res.headersSent) send(res, 503, { error: message })
              else res.end()
            }
          }
        }),
      '运维工作台'
    )
  })
}
