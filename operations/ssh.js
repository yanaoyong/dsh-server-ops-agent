import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { enqueueGap } from './retained.js'
import { recordSignals } from './signals.js'
import path from 'node:path'
import { pkg, sshInterval } from './paths.js'
import { atomic, now, observe, audit } from './ledger.js'
export function validAlias(alias) {
  return typeof alias === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(alias)
}
export async function collectHost(db, host, { port } = {}) {
  if (!validAlias(host.alias)) throw Error('SSH 别名无效')
  const priorHost = db.prepare('SELECT alias FROM hosts WHERE id=?').get(host.id)
  if (priorHost && priorHost.alias !== host.alias) throw Error('已有主机身份绑定，须另行迁移')
  if (db.prepare('SELECT 1 FROM container_entries WHERE alias=?').get(host.alias))
    throw Error('此入口已登记为容器入口')
  const known = db.prepare('SELECT machine FROM identities WHERE host=?').get(host.id)
  if (known && !/^[a-f0-9]{64}$/.test(known.machine)) throw Error('已有机器身份格式无效')
  const inventory = db.prepare('SELECT body FROM inventories WHERE host=?').get(host.id)
  const names = new Set(inventory ? JSON.parse(inventory.body).containers.map(c => c.name) : [])
  const fourServices = known && ['base', 'appnode', 'example-gateway', 'example-site'].every(n => names.has(n))
  const scope = fourServices ? 'four-services' : 'linux'
  const data = await new Promise((resolve) => {
    const child = spawn(
      '/usr/bin/ssh',
      [
        ...(port ? ['-p', String(port)] : []),
        '-oBatchMode=yes',
        '-oStrictHostKeyChecking=yes',
        '-oUpdateHostKeys=no',
        '-oConnectTimeout=5',
        '-oClearAllForwardings=yes',
        '-oForwardAgent=no',
        '-oControlMaster=no',
        '-oControlPath=none',
        '-T',
        '--',
        host.alias,
        'python3 -I - --duty ' + scope + ' ' + (known?.machine ?? 'unbound')
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], timeout: 45000 }
    )
    let text = ''
    child.stdout.on('data', (b) => {
      text += b
      if (text.length > 32768) child.kill()
    })
    child.stdin.on('error', () => {})
    const collector = ['log-evidence.py', 'check-edge.py', 'linux-probe.py']
      .map(name => fs.readFileSync(path.join(pkg, name), 'utf8'))
      .join('\n')
    child.stdin.end(collector)
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      try {
        resolve(code === 0 ? JSON.parse(text) : null)
      } catch {
        resolve(null)
      }
    })
  })
  const valid = Boolean(data && /^[0-9a-f]{64}$/.test(data.identity) &&
    (!known || known.machine === data.identity) && data.signals?.['主机容量'])
  if (valid) {
    atomic(db, () => {
      const existing = db.prepare('SELECT id,alias,machine FROM hosts LEFT JOIN identities ON host=id WHERE id=?').get(host.id)
      if (existing && (existing.alias !== host.alias || (existing.machine && existing.machine !== data.identity)))
        throw Error('主机身份在采集期间发生变化')
      if (db.prepare('SELECT 1 FROM identities WHERE machine=? AND host<>?').get(data.identity, host.id))
        throw Error('该机器已登记在其他主机编号下')
      if (db.prepare('SELECT 1 FROM container_entries WHERE alias=?').get(host.alias))
        throw Error('此入口已登记为容器入口')
      db.prepare('INSERT OR IGNORE INTO hosts VALUES(?,?,?)').run(host.id, now(), host.alias)
      db.prepare('INSERT OR IGNORE INTO identities VALUES(?,?)').run(host.id, data.identity)
    })
  } else if (!priorHost) {
    throw Error('首次 SSH 身份或采集未核实，未登记主机')
  }
  const prior = db
    .prepare(
      "SELECT state,ts FROM samples WHERE host=? AND signal='SSH 连接' ORDER BY id DESC LIMIT 1"
    )
    .get(host.id)
  if (valid && prior && (prior.state !== 'ok' || now()-prior.ts > sshInterval*2+5)) {
    const good = db.prepare("SELECT MAX(ts) AS ts FROM samples WHERE host=? AND signal='SSH 连接' AND state='ok'").get(host.id)
    if (good.ts) enqueueGap(db,host.id,good.ts,now())
  }
  observe(db, host.id, 'SSH 连接', valid ? 'ok' : 'bad', {
    verified: Boolean(valid),
    source: host.alias,
    reason: valid ? null : data ? '机器身份不匹配' : '连接或采集失败'
  })
  if (valid) {
    if (
      prior?.state !== 'ok' ||
      Date.now() / 1000 - prior.ts > sshInterval * 2 + 5
    )
      audit(db, null, 'collector', 'SSH 已重连', { host: host.id })
    recordSignals(db, host.id, data.signals)
    if (
      prior?.state !== 'ok' ||
      Date.now() / 1000 - prior.ts > sshInterval * 2 + 5
    )
      audit(db, null, 'collector', '数据已更新', {
        host: host.id,
        signals: Object.keys(data.signals).length
      })
  } else {
    const signals = db
      .prepare(
        "SELECT DISTINCT signal FROM samples WHERE host=? AND signal!='SSH 连接' AND signal NOT LIKE 'appnode · %' AND signal NOT LIKE '用户反馈 · %'"
      )
      .all(host.id)
    for (const { signal } of signals)
      observe(db, host.id, signal, 'unknown', { reason: 'SSH 采集未完成' })
  }
  return valid
}

// OpenSSH resolves aliases locally. Only the alias and verified port mapping enter the ledger.
function endpoint(alias) {
  const output = execFileSync('/usr/bin/ssh', ['-G', '--', alias], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
  })
  return Object.fromEntries(output.trim().split('\n').map(line => {
    const space = line.indexOf(' ')
    return [line.slice(0, space), line.slice(space + 1)]
  }))
}

export function linkContainerEntry(db, host, container, alias) {
  if (!validAlias(alias)) throw Error('需要有效的容器 SSH 别名')
  atomic(db, () => {
    const source = db.prepare(
      'SELECT alias,body,ts FROM hosts JOIN identities ON identities.host=id JOIN inventories ON inventories.host=id WHERE id=?'
    ).get(host)
    if (!source) throw Error('需要已验证主机与其容器盘点')
    if (db.prepare('SELECT 1 FROM hosts WHERE alias=?').get(alias)) throw Error('该入口已属于宿主机')
    const prior = db.prepare('SELECT host,container FROM container_entries WHERE alias=?').get(alias)
    if (prior && (prior.host !== host || prior.container !== container))
      throw Error('入口已关联其他主机或容器')
    const record = JSON.parse(source.body).containers.find(c => c.name === container && c.observed)
    const base = endpoint(source.alias), child = endpoint(alias)
    const sameRoute = ['hostname', 'proxyjump', 'proxycommand'].every(key => base[key] === child[key])
    const published = record?.published_ports?.['22/tcp'] ?? []
    const matched = published.some(bind => String(bind.HostPort) === child.port &&
      ['0.0.0.0', '::', base.hostname].includes(bind.HostIp))
    if (!sameRoute || base.port === child.port || !matched) throw Error('SSH 入口与已盘点的宿主发布端口不符')
    db.prepare('INSERT OR REPLACE INTO container_entries VALUES(?,?,?,?,?)')
      .run(alias, host, container, Number(child.port), source.ts)
    audit(db, null, 'operator', '核实容器入口', { host, container, alias, port: Number(child.port), inventory_ts: source.ts })
  })
}
