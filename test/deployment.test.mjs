import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { connectionAction, loadConnections } from '../connections.js'
import { deployOffer, deployRelease } from '../deployment.js'
import { endpoint } from '../ssh-client.js'

const target = { host: 'server.example.com', port: 22, user: 'opslogin',
  fingerprint: 'SHA256:' + 'A'.repeat(43), keyPath: '' }

test('a regular SSH account receives instructions without a deployment confirmation', async () => {
  const pending = new Map()
  const { install } = await deployOffer({ run: async () => ({ code: 22 }) }, target, pending, false)
  assert.equal(install.confirmation, undefined)
  assert.match(install.instructions, /sha256sum -c/)
  assert.match(install.instructions, /usermod -aG server-ops-read -- 'opslogin'/)
  assert.equal(pending.size, 0)
  assert.throws(() => endpoint({ ...target, user: 'ops; false' }), /SSH/)
})

test('a new verification invalidates the previous confirmation for that endpoint', async () => {
  const pending = new Map()
  const ssh = { run: async (_command, input) => {
    assert.equal(input, '')
    return { code: 0 }
  } }
  const { install: first } = await deployOffer(ssh, target, pending, false)
  const { install: second } = await deployOffer(ssh, target, pending, true)
  assert(!pending.has(first.confirmation))
  assert.equal(pending.get(second.confirmation).grantOnly, true)
  assert.doesNotMatch(second.instructions, /install-linux/)
})

test('the confirmed upload uses the same checksum as the installer prompt', async () => {
  const { version, digest, bytes } = JSON.parse(await readFile(
    new URL('../generated/linux-release.json', import.meta.url)))
  let sent = false
  await deployRelease({ run: async (command, archive) => {
    assert.match(command, new RegExp(digest + ' ' + bytes + ' install'))
    assert.equal(archive.length, bytes)
    assert.equal(createHash('sha256').update(archive).digest('hex'), digest)
    sent = true
    return { code: 0 }
  } }, false)
  assert(sent)
  assert.match(version, /-beta\./)
})

test('deployment requires an issued confirmation before creating a connection', async () => {
  const stop = await loadConnections({ kv: { open: async () => ({
    loadAll: async () => ({}), close: async () => {}
  }) } })
  try {
    await assert.rejects(connectionAction('connection-deploy', target), /部署确认已失效/)
    assert.deepEqual(await connectionAction('connection-status', {}), { active: null, servers: [] })
  } finally {
    await stop()
  }
})
