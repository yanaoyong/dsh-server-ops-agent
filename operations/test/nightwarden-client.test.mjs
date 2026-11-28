import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createNightWardenClient, decisionRequest } from '../nightwarden-client.js'

const baseUrl = 'https://nightwarden.example.test'
const cookie = 'session=test-value'
const id = 'session-1'
const row = {sessionId: id, title: 'disk', createdAt: '2026-01-01T01:20:00Z',
  lastActivityAt: '2026-01-01T01:21:00Z', investigation: true, severityLabel: null,
  status: 'action_required', statusLine: null, awaitingHumanInput: true}
const page = {rows: [row], investigationTotal: 4, nextOffset: 1}
const detail = {...row, running: false, reopenable: false, alerts: [], transcript: []}
const report = {record: {candidates: [], findings: [], report: null, updatedAt: row.lastActivityAt},
  evidence: [], decisions: []}
function setup(respond, timeoutMs) {
  const calls = []
  const client = createNightWardenClient({baseUrl, cookie, timeoutMs, fetchImpl(url, options) {
    calls.push({url, ...options})
    return respond(url, options)
  }})
  return {client, calls}
}

test('reads fixed upstream list, detail, auth and report using only the configured origin', async () => {
  const auth = {ownerExists: true, authenticated: true, email: 'operator@example.test', name: 'Test'}
  const replies = [page, detail, report, auth]
  const {client, calls} = setup(() => Response.json(replies.shift()))
  assert.deepEqual(await client.listSessions({limit: 1}), page)
  assert.deepEqual(await client.session(id), detail)
  assert.deepEqual(await client.report(id), report)
  assert.deepEqual(await client.authStatus(), auth)
  assert.deepEqual(calls.map(call => call.url.pathname + call.url.search),
    ['/api/sessions?kind=investigation&limit=1&offset=0', '/api/sessions/session-1',
      '/api/sessions/session-1/report', '/api/auth-status'])
  assert.ok(calls.every(c => c.method === 'GET' && c.url.origin === baseUrl &&
    c.headers.cookie === cookie && c.redirect === 'manual'))
})

test('separates missing report, unknown session, bad payload and lost authentication', async () => {
  const responses = [
    Response.json({error: 'no report for session'}, {status: 404}),
    Response.json({error: 'unknown session'}, {status: 404}),
    Response.json(null),
    Response.json({...detail, sessionId: 'wrong'}),
    Response.json({...page, nextOffset: 0}),
    Response.json({error: cookie}, {status: 401}),
    Response.json({}, {status: 403}),
    new Response('<html>', {headers: {'content-type': 'text/html'}})
  ]
  const {client} = setup(() => responses.shift())
  assert.equal(await client.report(id), null)
  await assert.rejects(client.report(id), {status: 404})
  await assert.rejects(client.report(id), {status: 502})
  await assert.rejects(client.session(id), {status: 502})
  await assert.rejects(client.listSessions(), {status: 502})
  await assert.rejects(client.session(id), e => e.status === 401 && !e.message.includes(cookie))
  await assert.rejects(client.session(id), {status: 403})
  await assert.rejects(client.session(id), {status: 502})
})

test('appends once to the original thread and returns its busy status without retry', async () => {
  const clientMessageId = randomUUID()
  const responses = [Response.json({sessionId: id}, {status: 202}), Response.json({}, {status: 409})]
  const {client, calls} = setup(() => responses.shift())
  assert.deepEqual(await client.appendMessage(id, {message: '  当前影响？ ', clientMessageId}), {sessionId: id})
  assert.equal(calls[0].url.pathname, '/api/sessions/session-1/messages')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.origin, baseUrl)
  assert.deepEqual(JSON.parse(calls[0].body), {message: '当前影响？', clientMessageId})
  await assert.rejects(client.appendMessage(id, {message: '证据？', clientMessageId}), {status: 409})
  await assert.rejects(client.appendMessage(id, {message: 'x', clientMessageId: 'invalid'}))
  assert.equal(calls.length, 2)
  assert.deepEqual(decisionRequest(id, {decision: 'reject', text: '范围不符'}),
    {method: 'POST', path: '/api/sessions/session-1/respond', body: {decision: 'reject', text: '范围不符'}})
  assert.throws(() => decisionRequest(id, {}))
})

test('rejects credential redirects, unsafe config, invalid paths and pagination', async () => {
  const {client, calls} = setup(() => new Response('', {status: 307, headers: {location: 'https://elsewhere.test'}}))
  await assert.rejects(client.session(id), {status: 502})
  await assert.rejects(client.session('../config'))
  await assert.rejects(client.listSessions({offset: -1}))
  assert.equal(calls.length, 1)
  for (const invalid of ['http://lan.test', 'https://user:pass@server.test', 'https://server.test/api'])
    assert.throws(() => createNightWardenClient({baseUrl: invalid, cookie}))
  assert.throws(() => createNightWardenClient({baseUrl, cookie: 'session=x\r\ntest'}))
})

test('timeouts abort the original request and report an unknown outcome to the caller', async () => {
  const {client, calls} = setup((url, {signal}) => new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(Error('abort never arrived')), 500)
    signal.addEventListener('abort', () => { clearTimeout(guard); reject(signal.reason) }, {once: true})
  }), 10)
  await assert.rejects(client.appendMessage(id, {message: 'status?', clientMessageId: randomUUID()}),
    {status: 504})
  assert.equal(calls.length, 1)
})
