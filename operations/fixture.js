import http from 'node:http'
import { now, atomic, audit, observe, hash } from './ledger.js'
import { mac } from './paths.js'

function listen(server) {
  return new Promise((resolve, reject) =>
    server
      .once('error', reject)
      .listen(0, '127.0.0.1', () =>
        resolve('http://127.0.0.1:' + server.address().port + '/health')
      )
  )
}
export async function fixture(db) {
  const upstream = http.createServer((req, res) => {
    const ok = db.prepare('SELECT online FROM fixture').get().online === 1
    res
      .writeHead(ok ? 200 : 503)
      .end(ok ? 'server-ops:healthy' : 'fixture offline')
  })
  const upstreamURL = await listen(upstream)
  const proxy = http.createServer(async (req, res) => {
    try {
      const response = await fetch(upstreamURL, {
        signal: AbortSignal.timeout(1500)
      })
      res.writeHead(response.ok ? 200 : 502).end(await response.text())
    } catch {
      res.writeHead(502).end('upstream unavailable')
    }
  })
  const proxyURL = await listen(proxy)
  async function probe() {
    const fetchStatus = async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
        return { http: r.status, body: await r.text() }
      } catch {
        return { http: null, body: '连接中断' }
      }
    }
    const [edge, origin] = await Promise.all([
      fetchStatus(proxyURL),
      fetchStatus(upstreamURL)
    ])
    return { edge, origin, source: proxyURL, upstream: upstreamURL }
  }
  return {
    probe,
    close() {
      proxy.close()
      upstream.close()
    }
  }
}
export function fault(db) {
  db.prepare(
    'UPDATE fixture SET online=0,generation=generation+1 WHERE online=1'
  ).run()
}
export function recordProbe(db, value) {
  const state =
    value.edge.http == null
      ? 'unknown'
      : value.edge.http === 200 && value.edge.body === 'server-ops:healthy'
        ? 'ok'
        : 'bad'
  return observe(db, mac, '代理可用性', state, value)
}
export async function execute(db, probe, { loseReceipt = false } = {}) {
  const plans = db
    .prepare(
      "SELECT * FROM plans WHERE status IN ('approved','executing','unknown') ORDER BY rowid"
    )
    .all()
  for (const p of plans) {
    const b = JSON.parse(p.body)
    let receipt = db
      .prepare('SELECT * FROM receipts WHERE execution=?')
      .get(p.execution)
    if (!receipt && p.status !== 'approved') {
      if (p.status !== 'unknown') {
        db.prepare("UPDATE plans SET status='unknown' WHERE id=?").run(p.id)
        audit(db, p.incident, 'executor', '结果待核实', {
          execution: p.execution,
          probe: await probe()
        })
      }
      continue
    }
    if (!receipt) {
      const before = await probe()
      const c = db.prepare('SELECT * FROM cases WHERE id=?').get(p.incident)
      const f = db.prepare('SELECT * FROM fixture').get()
      if (
        hash(p.body) !== p.digest ||
        b.action !== 'enable-fixture-v1' ||
        b.host !== mac ||
        b.incident !== c.id ||
        c.host !== mac ||
        c.closed ||
        now() >= b.expires ||
        f.online ||
        f.generation !== b.args.generation ||
        before.edge.http !== 502
      ) {
        db.prepare("UPDATE plans SET status='expired' WHERE id=?").run(p.id)
        audit(db, c.id, 'executor', '前置条件不符', { plan: p.id, before })
        continue
      }
      atomic(db, () => {
        db.prepare("UPDATE plans SET status='executing' WHERE id=?").run(p.id)
        db.prepare('UPDATE fixture SET online=1 WHERE id=1').run()
        db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(
          p.execution,
          now(),
          '已启用登记的回环上游'
        )
        audit(db, c.id, 'executor', '执行固定动作', {
          execution: p.execution,
          plan: p.id,
          before
        })
      })
      if (loseReceipt) continue
    } else
      audit(db, p.incident, 'executor', '已按执行编号对账', {
        execution: p.execution
      })
    const after = await probe()
    recordProbe(db, after)
    const status =
      after.edge.http === 200 && after.edge.body === 'server-ops:healthy'
        ? 'verified'
        : 'failed'
    db.prepare('UPDATE plans SET status=? WHERE id=?').run(status, p.id)
    audit(db, p.incident, 'executor', '执行回执及业务复查', {
      execution: p.execution,
      status,
      after
    })
  }
}
