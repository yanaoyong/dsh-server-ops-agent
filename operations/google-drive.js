import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { validAlias } from './ssh.js'

const operations = new Map([
  ['google-status', 'status'], ['google-connect', 'connect'],
  ['google-history-points', 'points'], ['google-history-capture', 'capture'], ['google-history-browse', 'browse'],
  ['google-history-changes', 'changes'], ['google-history-preview', 'preview'], ['google-history-job', 'job'],
  ['google-history-restore', 'submit'], ['google-retry', 'retry'], ['google-restore', 'restore']
])
const sessions = new Map()

export async function googleDrive(db, action, data) {
  const operation = operations.get(action)
  if (!operation || data.host !== 'example-host') throw Error('请选择已登记的工作区宿主机')
  const record = db.prepare('SELECT h.alias,i.machine FROM workbench_hosts h JOIN identities i ON i.host=h.id JOIN inventories v ON v.host=h.id WHERE h.id=?').get(data.host)
  if (!record || !validAlias(record.alias) || !/^[a-f0-9]{64}$/.test(record.machine))
    throw Error('主机身份尚未核实')
  const session = sessions.get(record.machine)
  if (operation === 'connect' && session?.active) {
    if (session.url) return {url: session.url}
    throw Error('授权窗口正在启动')
  }
  const history = action.startsWith('google-history-')
  const payload = history ? {point: data.point, path: data.path, offset: data.offset,
    paths: data.paths, source: data.source, requestId: data.requestId, owner: data.owner,
    day: data.day, endDay: data.endDay, fromTime: data.fromTime, untilTime: data.untilTime,
    directory: data.directory, keyword: data.keyword, intervalIndex: data.intervalIndex} : {}
  if (operation === 'connect' && data.client != null) {
    const {client_id, client_secret} = data.client.installed || {}
    if (typeof client_id !== 'string' || typeof client_secret !== 'string' ||
        client_id.length > 256 || client_secret.length > 256)
      throw Error('请选择桌面应用客户端文件')
    payload.client = {client_id, client_secret}
  } else if (operation === 'restore') {
    if (!Number.isSafeInteger(data.point) || data.point <= 0) throw Error('请选择已验证的恢复点')
    payload.point = data.point
  }
  const auth = operation === 'connect'
  const current = {active: auth}
  if (auth) sessions.set(record.machine, current)
  const args = ['-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oForwardAgent=no',
    '-oControlMaster=no', '-oControlPath=none', '-oConnectTimeout=8', '-oServerAliveInterval=15',
    ...(auth ? ['-oExitOnForwardFailure=yes', '-L', '127.0.0.1:53682:127.0.0.1:53682'] :
      ['-oClearAllForwardings=yes']), '--', record.alias,
    'python3 -I /var/lib/dsh-workspace-private/' + (history ? 'workspace_history.py ' : 'google_drive.py ') + operation + ' ' + record.machine]
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/ssh', args, {stdio: ['pipe','pipe','ignore'],
      timeout: auth ? 720000 : ['browse','preview','changes'].includes(operation) ? 3600000 : operation === 'restore' ? 6*3600000 : 30000})
    let result = null
    const lines = createInterface({input: proc.stdout})
    lines.on('line', line => {
      try { result = JSON.parse(line) } catch { return }
      if (auth && /^http:\/\/127\.0\.0\.1:53682\/auth\?state=[A-Za-z0-9_%=-]+$/.test(result?.url)) {
        current.url = result.url
        resolve({url: current.url})
      }
    })
    proc.stdin.on('error', () => {})
    proc.stdin.end(JSON.stringify(payload))
    proc.on('error', () => {
      current.active = false
      reject(Error('无法启动服务器连接'))
    })
    proc.on('close', code => {
      current.active = false
      current.url = null
      if (code !== 0 || result?.error || (!auth && !result)) {
        current.error = result?.error || (auth ? '授权连接失败，请检查本机授权端口是否占用' : '无法读取服务器网盘任务')
        reject(Error(current.error))
      } else if (operation === 'status') {
        resolve({...result, authorizing: Boolean(session?.active), authError: session?.error})
      } else resolve(auth ? {connected: true} : result)
    })
  })
}
