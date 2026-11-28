import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openLedger, now, observe, makePlan } from '../ledger.js'
import { collectHost } from '../ssh.js'
import { dispatch } from '../model.js'

test('failed SSH connection retains last good evidence and isolates approvals', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-ssh-'))
  const db = openLedger(dir)
  t.after(async () => {
    db.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
  const id = 'ssh-outage'
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(id, now(), '127.0.0.1')
  observe(db, id, '容器 base', 'ok', { status: 'running' }, now() - 120)
  // A reserved, closed local listener simulates an unreachable registered target.
  await collectHost(db, { id, alias: '127.0.0.1' }, { port: 1 })
  const series = db
    .prepare(
      "SELECT state FROM samples WHERE host=? AND signal='容器 base' ORDER BY id"
    )
    .all(id)
  assert.deepEqual(
    series.map((r) => r.state),
    ['ok', 'unknown']
  )
  const outage = db
    .prepare("SELECT id FROM cases WHERE host=? AND signal='SSH 连接'")
    .get(id)
  assert.throws(() => makePlan(db, outage.id))
  await dispatch(db, async () => {
    throw Error('model outage')
  })
  const q = db
    .prepare('SELECT * FROM investigations WHERE incident=?')
    .get(outage.id)
  assert.equal(q.status, 'retry')
})

test('an unreachable first connection creates no host, identity or schedule', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-first-ssh-'))
  const db = openLedger(dir)
  t.after(async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }) })
  await assert.rejects(collectHost(db, { id: 'new-linux', alias: '127.0.0.1' }, { port: 1 }), /未登记主机/)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM hosts WHERE id='new-linux'").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM enrolled').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM identities').get().n, 0)
})
