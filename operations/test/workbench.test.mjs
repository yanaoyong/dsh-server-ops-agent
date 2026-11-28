import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { apply } from '../plugin.js'

test('workbench accepts only its authenticated desktop bridge or same-origin web client', async t => {
  const peer = {}
  let handler
  apply({ inject: (services, register) => services.includes('webServer') && register({
    effect: register => register(),
    connection: {
      browserPeer: peer,
      admit: req => req.headers.cookie === 'fixture=yes' ? { peer } : { rejection: 401 }
    },
    webServer: { register: route => { handler = route.handler } }
  }) })
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = 'http://127.0.0.1:' + server.address().port
  async function status(client, headers = {}) {
    // Unknown action returns 404 after admission, without contacting the daemon.
    const response = await fetch(origin + '/server-operations/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'fixture=yes', 'x-server-ops': client, ...headers },
      body: JSON.stringify({ action: 'test-routing' })
    })
    await response.text()
    return response.status
  }
  assert.equal(await status('1', { origin }), 404)
  assert.equal(await status('1'), 403)
  assert.equal(await status('1', { origin, cookie: '' }), 403)
  assert.equal(await status('1', { origin: 'http://example.invalid' }), 403)
  const desktop = process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1'
  assert.equal(await status('desktop'), desktop ? 404 : 403)
  assert.equal(await status('desktop', { cookie: '' }), 403)
  assert.equal(await status('desktop', { origin }), 403)
  assert.equal(await status('desktop', { 'sec-fetch-site': 'cross-site' }), 403)
})
