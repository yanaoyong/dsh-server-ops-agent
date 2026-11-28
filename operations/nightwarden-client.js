// HTTP contract pinned to PrabhatMattoo/NightWarden f6b78bd, apps/api/src/session/routes.ts.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = value => typeof value === 'string'
const nullableString = value => value === null || string(value)
const objects = value => Array.isArray(value) && value.every(record)
const integer = value => Number.isSafeInteger(value) && value >= 0
const noReport = Symbol('no report')
const statuses = new Set(['action_required', 'running', 'resolved', 'stopped', 'failed', 'completed', 'not_started'])

function sessionPath(id) {
  if (!string(id) || !id || id === '.' || id === '..' || /[/\\\s\x00-\x1f\x7f]/.test(id))
    throw Error('NightWarden 会话编号无效')
  return '/api/sessions/' + encodeURIComponent(id)
}

function verified(valid) {
  if (!valid) throw new NightWardenError(502, 'NightWarden 返回的数据与当前适配版本不符')
}

export class NightWardenError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'NightWardenError'
    this.status = status
  }
}

function sessionMeta(row) {
  return record(row) && string(row.sessionId) && row.sessionId.length > 0 &&
    string(row.title) && string(row.createdAt) && string(row.lastActivityAt) &&
    typeof row.investigation === 'boolean'
}

function reportShape(value) {
  if (!record(value) || !record(value.record)) return false
  const {candidates, findings, report, updatedAt} = value.record
  return string(updatedAt) && objects(candidates) && objects(findings) &&
    (report === null || (record(report) && string(report.headline) && string(report.summary) &&
      string(report.affected) && string(report.impact) && string(report.recommendation) &&
      string(report.submittedAt) && objects(report.timeline))) &&
    objects(value.decisions) && value.decisions.every(d => string(d.toolCallId) && string(d.toolName) &&
      ['approved', 'rejected'].includes(d.decision)) &&
    objects(value.evidence) && value.evidence.every(e => string(e.evidenceId) &&
      string(e.toolCallId) && string(e.toolName) && string(e.result))
}

// Only describes the upstream request. The upstream gate has no expected toolCallId
// field, so a caller must address stale approvals before wiring execution to a button.
export function decisionRequest(id, {decision, text} = {}) {
  if (!['approve', 'reject'].includes(decision) || (text !== undefined && !string(text)))
    throw Error('请明确选择批准或拒绝')
  return {method: 'POST', path: sessionPath(id) + '/respond', body: {
    decision, ...(text !== undefined && {text})
  }}
}

export function createNightWardenClient({baseUrl, cookie, timeoutMs = 8000, fetchImpl = fetch}) {
  if (!URL.canParse(baseUrl)) throw Error('NightWarden 服务地址无效')
  const base = new URL(baseUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  if ((base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) ||
      base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw Error('NightWarden 地址应为 HTTPS 服务源或本机回环地址')
  if (!string(cookie) || !cookie.trim() || /[^\x20-\x7e]/.test(cookie))
    throw Error('NightWarden 会话凭据无效')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw Error('NightWarden 超时配置无效')

  async function request(path, {body, status = 200, optionalReport = false} = {}) {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const headers = {accept: 'application/json', cookie}
      if (body) {
        headers['content-type'] = 'application/json'
        headers.origin = base.origin
      }
      const response = await fetchImpl(new URL(path, base), {
        method: body ? 'POST' : 'GET', headers, redirect: 'manual', signal,
        ...(body && {body: JSON.stringify(body)})
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new NightWardenError(502, 'NightWarden 返回重定向，请核对服务地址')
      }
      if (response.status !== status) {
        if (optionalReport && response.status === 404 &&
            (await response.json().catch(() => null))?.error === 'no report for session') return noReport
        await response.body?.cancel().catch(() => {})
        const refused = {401: '会话已过期，请重新认证', 403: '当前账号权限不足', 404: '找不到调查',
          409: '调查正在运行或等待决定，请刷新原事件', 503: '服务暂不可用'}
        throw new NightWardenError(response.status >= 400 ? response.status : 502, 'NightWarden ' + (refused[response.status] || '请求失败'))
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel()
        throw new NightWardenError(502, 'NightWarden 返回了非 JSON 响应')
      }
      return await response.json()
    } catch (error) {
      if (signal.aborted) throw new NightWardenError(504, 'NightWarden 请求超时')
      if (error instanceof NightWardenError) throw error
      if (error instanceof SyntaxError) throw new NightWardenError(502, 'NightWarden 返回了无效 JSON')
      throw new NightWardenError(502, '无法连接 NightWarden')
    }
  }
  return {
    async modelRoute() {
      const value=await request('/api/config')
      verified(record(value) && (value.provider===null || (string(value.provider) && record(value.providers?.[value.provider]))))
      if(!value.provider) return null
      const model=value.providers[value.provider].model
      return typeof model==='string' && model ? value.provider+' / '+model : null
    },
    async authStatus() {
      const value = await request('/api/auth-status')
      verified(record(value) && (value.ownerExists === false || (value.ownerExists === true &&
        (value.authenticated === false || (value.authenticated === true && string(value.email) && string(value.name))))))
      return value
    },
    async listSessions({kind = 'investigation', limit = 50, offset = 0} = {}) {
      if (!['investigation', 'chat'].includes(kind) || !integer(limit) || limit < 1 ||
          limit > 200 || !integer(offset)) throw Error('NightWarden 会话分页参数无效')
      const value = await request('/api/sessions?' + new URLSearchParams({kind, limit, offset}))
      verified(record(value) && Array.isArray(value.rows) && value.rows.every(row => sessionMeta(row) &&
        row.investigation === (kind === 'investigation') && typeof row.awaitingHumanInput === 'boolean' &&
        nullableString(row.severityLabel) && nullableString(row.statusLine) &&
        (row.status === null || statuses.has(row.status))) && integer(value.investigationTotal) &&
        (value.nextOffset === null || (integer(value.nextOffset) && value.nextOffset > offset)))
      return value
    },
    async session(id) {
      const value = await request(sessionPath(id))
      verified(sessionMeta(value) && value.sessionId === id && typeof value.running === 'boolean' &&
        typeof value.reopenable === 'boolean' && objects(value.alerts) && value.alerts.every(item =>
          record(item.alert) && record(item.alert.labels) && string(item.alert.sourceAlertId)) &&
        objects(value.transcript) && value.transcript.every(item => string(item.kind)))
      return value
    },
    async report(id) {
      const value = await request(sessionPath(id) + '/report', {optionalReport: true})
      if (value === noReport) return null
      verified(reportShape(value))
      return value
    },
    async appendMessage(id, {message, clientMessageId} = {}) {
      const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
      if (!string(message) || !message.trim() || !string(clientMessageId) || !uuid.test(clientMessageId))
        throw Error('追问需要正文和有效的消息编号')
      const value = await request(sessionPath(id) + '/messages', {
        body: {message: message.trim(), clientMessageId}, status: 202
      })
      verified(record(value) && value.sessionId === id)
      return value
    }
  }
}
