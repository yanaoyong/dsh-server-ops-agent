import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { maxRequestBytes, maxResponseBytes, requestTimeout, sshCommand } from './connection-protocol.js'

export class ServiceUnavailable extends Error {
  constructor(message, grantOnly = false) {
    super(message)
    this.grantOnly = grantOnly
  }
}

export function endpoint(data) {
  const host = typeof data?.host === 'string' ? data.host.trim() : ''
  const user = typeof data?.user === 'string' ? data.user.trim() : ''
  const fingerprint = typeof data?.fingerprint === 'string' ? data.fingerprint.trim() : ''
  const keyPath = typeof data?.keyPath === 'string' ? data.keyPath.trim() : ''
  const port = Number(data?.port ?? 22)
  if (!(isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(user) ||
      !Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('请填写有效的 SSH 主机、端口和用户名')
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw Error('请输入服务器公布的 SHA256 主机指纹')
  if (keyPath && (!(path.isAbsolute(keyPath) || /^[~][/\\]/.test(keyPath)) ||
      keyPath.length > 1000 || /[\x00-\x1f]/.test(keyPath)))
    throw Error('请填写本机 SSH 私钥的绝对路径')
  return { host, port, user, fingerprint, keyPath }
}

async function authentication({ keyPath, user }) {
  const methods = []
  if (!keyPath && process.env.SSH_AUTH_SOCK)
    methods.push({ type: 'agent', username: user, agent: process.env.SSH_AUTH_SOCK })
  const files = keyPath
    ? [keyPath.startsWith('~') ? path.join(homedir(), keyPath.slice(2)) : keyPath]
    : ['id_ed25519', 'id_ecdsa', 'id_rsa'].map(name => path.join(homedir(), '.ssh', name))
  for (const file of files) {
    try {
      const info = await stat(file)
      if (info.isFile() && info.size <= 64 * 1024)
        methods.push({ type: 'publickey', username: user, key: await readFile(file) })
    } catch {}
  }
  if (!methods.length) throw Error('找不到可用的 SSH 身份，请填写私钥路径或启用 SSH agent')
  return methods
}

export class SshConnection {
  constructor(config) {
    this.config = config
    this.lastConnectedAt = null
  }

  async connect() {
    const { default: { Client } } = await import('./generated/ssh-client.cjs')
    const auth = await authentication(this.config)
    if (this.closed) throw Error('SSH 连接已关闭')
    const client = new Client()
    this.client = client
    let wrongKey = false
    return new Promise((resolve, reject) => {
      const failure = () => reject(Error(wrongKey ? '服务器 SSH 主机指纹不匹配' : 'SSH 连接或身份认证失败'))
      // ssh2 keeps trying the auth queue after an agent or signature error.
      client.on('error', error => {
        if (!['agent', 'client-authentication'].includes(error.level)) failure()
      })
      client.once('close', () => {
        if (this.client === client) {
          this.client = null
          this.connecting = null
        }
        failure()
      })
      client.once('ready', () => {
        this.lastConnectedAt = Math.floor(Date.now() / 1000)
        resolve(client)
      })
      try {
        client.connect({
          host: this.config.host, port: this.config.port, username: this.config.user,
          authHandler: auth, readyTimeout: 7500, keepaliveInterval: 5000, keepaliveCountMax: 2,
          hostVerifier: key => {
            const digest = createHash('sha256').update(key).digest('base64').replace(/=$/, '')
            wrongKey = 'SHA256:' + digest !== this.config.fingerprint
            return !wrongKey
          }
        })
      } catch {
        this.client = null
        failure()
      }
    })
  }

  async request(action, data = {}) {
    const input = JSON.stringify({ action, data }) + '\n'
    if (Buffer.byteLength(input) > maxRequestBytes + 1) throw Error('请求超过大小上限')
    const { code, output } = await this.run(sshCommand, input, requestTimeout, maxResponseBytes + 1)
    if (code === 127) throw new ServiceUnavailable('服务器运维入口尚未安装')
    if (code !== 0) throw Error('服务器运维入口不可用')
    let body
    try { body = JSON.parse(output) }
    catch { throw Error('服务器运维入口返回格式无效') }
    if (body?.error) {
      const message = typeof body.error === 'string' && /^[\u3400-\u9fffA-Za-z0-9 、]{1,100}$/u.test(body.error)
        ? body.error : '服务器运维请求失败'
      if (message === '当前 SSH 用户没有运维服务读取权限') throw new ServiceUnavailable(message, true)
      throw Error(message)
    }
    return body
  }

  async run(command, input, timeout, limit) {
    if (this.closed) throw Error('SSH 连接已关闭')
    clearTimeout(this.idle)
    this.pending = (this.pending ?? 0) + 1
    try {
      this.connecting ??= this.connect().catch(error => {
        this.client?.destroy()
        this.connecting = null
        throw error
      })
      const client = await this.connecting
      return await this.exec(client, command, input, timeout, limit)
    } finally {
      if (--this.pending === 0 && !this.closed) {
        this.idle = setTimeout(() => this.client?.end(), 12_000)
        this.idle.unref()
      }
    }
  }

  exec(client, command, input, timeout, limit) {
    return new Promise((resolve, reject) => {
      let stream, settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.removeListener('close', disconnected)
        if (error) reject(error)
        else resolve(value)
      }
      const disconnected = () => finish(Error('SSH 连接已断开，请重试'))
      const timer = setTimeout(() => {
        finish(Error('Linux 运维操作超时'))
        stream?.destroy()
        if (!stream) client.destroy()
      }, timeout)
      client.once('close', disconnected)
      client.exec(command, (error, channel) => {
        if (settled) { channel?.destroy(); return }
        if (error) { finish(Error('无法打开服务器运维入口')); return }
        stream = channel
        let size = 0
        const parts = []
        channel.stderr.resume()
        channel.on('data', part => {
          size += part.length
          if (size > limit) {
            finish(Error('服务器返回结果超过大小上限'))
            channel.destroy()
          } else parts.push(part)
        })
        channel.on('error', disconnected)
        channel.on('close', code => {
          if (settled) return
          finish(null, { code, output: Buffer.concat(parts).toString('utf8') })
        })
        channel.end(input)
      })
    })
  }

  close() {
    this.closed = true
    clearTimeout(this.idle)
    this.client?.destroy()
  }
}
