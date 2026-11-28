import { now, observe } from './ledger.js'

const defaults = {
  diskPct: 85,
  inodePct: 90,
  minMemoryPct: 8,
  loadPerCpu: 1.5,
  sshFailures: 8,
  proxyMinRequests: 20,
  proxyErrorPct: 10,
  restarts: 3
}
export function limits(db, host) {
  const row = db.prepare('SELECT body FROM limits WHERE host=?').get(host)
  return { ...defaults, ...JSON.parse(row?.body || '{}') }
}
export function setLimits(db, host, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw Error('需要阈值对象')
  for (const [key, value] of Object.entries(config)) {
    if (
      !Object.hasOwn(defaults, key) ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      (key.endsWith('Pct') && value > 100)
    )
      throw Error('阈值无效')
  }
  db.prepare('INSERT OR REPLACE INTO limits VALUES(?,?)').run(
    host,
    JSON.stringify({ ...limits(db, host), ...config })
  )
}
export function recordSignals(db, host, signals, ts = now(), options) {
  const config = limits(db, host)
  for (const [name, { state: observed, facts }] of Object.entries(signals)) {
    let state = observed
    if (name === '主机容量' && state !== 'unknown') {
      state =
        facts.root_used_pct >= config.diskPct ||
        facts.inode_used_pct >= config.inodePct ||
        facts.available_memory_pct < config.minMemoryPct ||
        facts.load15 > facts.logical_cpu * config.loadPerCpu
          ? 'bad'
          : 'ok'
    } else if (name.startsWith('挂载容量 ') && state !== 'unknown') {
      facts.threshold_pct = config.diskPct
      state = facts.used_pct >= config.diskPct ? 'bad' : 'ok'
    } else if (name === '可疑 IP') {
      facts.threshold = config.sshFailures
      state = facts.top.some(([, n]) => n >= config.sshFailures)
        ? 'bad'
        : (facts.window_complete ?? facts.journal_visible)
          ? 'ok'
          : 'unknown'
    } else if (name === '代理请求错误率') {
      facts.minimum_requests = config.proxyMinRequests
      facts.threshold_pct = config.proxyErrorPct
      state = facts.observed_5xx_pct == null ? 'unknown'
        : facts.access_records >= config.proxyMinRequests && 100 * facts.server_errors >= config.proxyErrorPct * facts.access_records ? 'bad' : 'ok'
    } else if (
      name.startsWith('容器 ') &&
      state !== 'unknown' &&
      facts.container_id
    ) {
      const baseline = db
        .prepare(
          "SELECT ts,value FROM samples WHERE host=? AND signal=? AND ts>=? AND state!='unknown' AND json_extract(value,'$.container_id')=? ORDER BY ts LIMIT 1"
        )
        .get(host, name, ts - 600, facts.container_id)
      if (baseline) {
        facts.restart_delta =
          Number(facts.status[2]) - Number(JSON.parse(baseline.value).status[2])
        facts.window_seconds = ts - baseline.ts
        if (facts.restart_delta >= config.restarts) state = 'bad'
      }
    }
    observe(db, host, name, state, facts, ts, options)
  }
}
