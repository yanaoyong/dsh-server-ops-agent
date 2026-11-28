import { randomUUID } from 'node:crypto'
import { atomic, now as unixNow } from './ledger.js'

const cooldownSeconds = 3600
const maxIdentifierLength = 256

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxIdentifierLength &&
    value === value.trim() && !/[\x00-\x1f\x7f]/.test(value)
}
function seconds(value) {
  return Number.isSafeInteger(value) && value >= 0
}

// The adapter must bind these callbacks to the configured container identity and business
// endpoint. Observation payloads never provide command arguments, URLs or credentials.
export function createNightwardenPolicy(db, {
  ruleId, host, container, probeId, restart, probe, now = unixNow,
  maxSampleAgeSeconds = 300, operationTimeoutMs = 30_000
}) {
  if (![ruleId, host, container, probeId].every(identifier) ||
      typeof restart !== 'function' || typeof probe !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(maxSampleAgeSeconds) || maxSampleAgeSeconds < 1 ||
      !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 2_147_483_647)
    throw Error('需要有效的固定规则、容器、业务探针和执行时限')
  const target = Object.freeze({ruleId, host, container, probeId})
  db.exec(`
    CREATE TABLE IF NOT EXISTS nw_policy_rules (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, container TEXT NOT NULL, probe_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT -1,
      last_at INTEGER NOT NULL DEFAULT -1, fence INTEGER NOT NULL DEFAULT -1,
      failures TEXT NOT NULL DEFAULT '[]', active_event TEXT, recovered_at INTEGER, recovered_event TEXT,
      UNIQUE(host,container,probe_id)
    );
    CREATE TABLE IF NOT EXISTS nw_policy_events (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, opened INTEGER NOT NULL, updated INTEGER NOT NULL,
      status TEXT NOT NULL, reason TEXT NOT NULL, samples TEXT NOT NULL,
      execution_id TEXT UNIQUE, claimed_at INTEGER, deadline INTEGER, restart_result TEXT, probe_result TEXT,
      verified_at INTEGER, observed_recovery INTEGER, related_event TEXT
    );
    CREATE INDEX IF NOT EXISTS nw_policy_history ON nw_policy_events(rule_id,opened);
    CREATE TABLE IF NOT EXISTS nw_policy_notices (
      event_id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, created INTEGER NOT NULL, delivered INTEGER
    );
    CREATE TABLE IF NOT EXISTS nw_policy_changes (
      id INTEGER PRIMARY KEY, rule_id TEXT NOT NULL, changed INTEGER NOT NULL, enabled INTEGER NOT NULL, actor TEXT NOT NULL
    );
  `)
  const rule = () => db.prepare('SELECT * FROM nw_policy_rules WHERE id=?').get(ruleId)
  atomic(db, () => {
    db.prepare('INSERT OR IGNORE INTO nw_policy_rules(id,host,container,probe_id) VALUES(?,?,?,?)')
      .run(ruleId, host, container, probeId)
    const row = rule()
    if (!row || row.host !== host || row.container !== container || row.probe_id !== probeId)
      throw Error('规则编号与已登记的目标不一致')
  })

  function clock() {
    const ts = now()
    if (!seconds(ts)) throw Error('规则时钟必须返回 Unix 秒')
    return ts
  }
  function setEnabled(enabled, actor = 'operator') {
    if (typeof enabled !== 'boolean' || !identifier(actor)) throw Error('规则开关或操作者无效')
    return atomic(db, () => {
      const value = Number(enabled)
      if (rule().enabled !== value) {
        const ts = clock()
        // A delayed sample from before a newly granted authorization cannot count toward it.
        db.prepare("UPDATE nw_policy_rules SET enabled=?, failures='[]', fence=MAX(fence,?) WHERE id=?")
          .run(value,ts,ruleId)
        db.prepare('INSERT INTO nw_policy_changes(rule_id,changed,enabled,actor) VALUES(?,?,?,?)')
          .run(ruleId, ts, value, actor)
      }
      return { ...target, enabled }
    })
  }

  function record(id) {
    const row = db.prepare('SELECT * FROM nw_policy_events WHERE id=? AND rule_id=?').get(id,ruleId)
    if (!row) return null
    return {...row, ...target, samples:JSON.parse(row.samples)}
  }
  function enqueue(id, ts) {
    db.prepare('INSERT OR IGNORE INTO nw_policy_notices(event_id,rule_id,created) VALUES(?,?,?)').run(id, ruleId, ts)
  }
  function createEvent(samples, ts, reason, related = null) {
    const id = randomUUID()
    const admitted = reason === 'preauthorized'
    const executionId = admitted ? randomUUID() : null
    const deadline = admitted ? ts + Math.ceil(2 * operationTimeoutMs / 1000) + 5 : null
    db.prepare(`INSERT INTO nw_policy_events
      (id,rule_id,opened,updated,status,reason,samples,execution_id,claimed_at,deadline,related_event)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,ruleId,samples[0].observedAt,ts,admitted ? 'claimed' : 'manual_required',reason,
        JSON.stringify(samples),executionId,admitted ? ts : null,deadline,related)
    db.prepare("UPDATE nw_policy_rules SET active_event=?,failures='[]' WHERE id=?").run(id,ruleId)
    if (!admitted) enqueue(id,ts)
    return {status:admitted ? 'claimed' : 'manual_required',event:record(id),execute:admitted}
  }

  function admit(observation) {
    const { sequence, observedAt, state } = observation
    const row = rule(), ts = clock()
    if (sequence <= row.last_seq || observedAt <= row.last_at || observedAt <= row.fence)
      return {status:'ignored',reason:'duplicate_or_out_of_order'}
    if (observedAt > ts || ts - observedAt > maxSampleAgeSeconds)
      return {status:'ignored',reason:'outside_sample_window'}
    db.prepare('UPDATE nw_policy_rules SET last_seq=?,last_at=? WHERE id=?').run(sequence,observedAt,ruleId)

    if (row.active_event) {
      const event = record(row.active_event)
      if (state === 'ok' && event.status !== 'claimed') {
        db.prepare('UPDATE nw_policy_events SET observed_recovery=?,updated=? WHERE id=?')
          .run(observedAt,ts,event.id)
        db.prepare("UPDATE nw_policy_rules SET active_event=NULL,recovered_at=?,recovered_event=?,failures='[]' WHERE id=?")
          .run(observedAt,event.id,ruleId)
      }
      return {status:'existing',event:record(event.id)}
    }
    if (state !== 'bad') {
      db.prepare("UPDATE nw_policy_rules SET failures='[]' WHERE id=?").run(ruleId)
      return {status:'observed',consecutiveFailures:0}
    }

    const point = {sequence, observedAt, state}
    if (row.recovered_at !== null && observedAt < row.recovered_at + cooldownSeconds)
      return createEvent([point],ts,'recurrence',row.recovered_event)
    const consecutive = sequence === row.last_seq + 1 && observedAt - row.last_at <= maxSampleAgeSeconds
    const failures = consecutive ? JSON.parse(row.failures) : []
    while (failures.length && ts - failures[0].observedAt > maxSampleAgeSeconds) failures.shift()
    failures.push(point)
    if (failures.length < 3) {
      db.prepare('UPDATE nw_policy_rules SET failures=? WHERE id=?').run(JSON.stringify(failures),ruleId)
      return {status:'observed',consecutiveFailures:failures.length}
    }
    return createEvent(failures,ts,row.enabled ? 'preauthorized' : 'disabled')
  }

  async function timed(callback, executionId) {
    const controller = new AbortController()
    let timer
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve('unknown') },operationTimeoutMs)
    })
    try {
      return await Promise.race([timeout, callback(target, executionId, controller.signal)])
    } catch {
      return 'unknown'
    } finally {
      clearTimeout(timer)
    }
  }

  function finish(id, restartResult, probeResult, reason) {
    return atomic(db, () => {
      const ts = clock(), event = record(id)
      if (event.status !== 'claimed') return event
      const status = probeResult === 'ok' ? 'recovered' : probeResult === 'bad' ? 'failed' : 'unknown'
      db.prepare(`UPDATE nw_policy_events SET status=?, reason=?,restart_result=?,probe_result=?,
        verified_at=?,updated=? WHERE id=?`).run(status,reason,restartResult,probeResult,
          probeResult === null ? null : ts, ts,id)
      db.prepare('UPDATE nw_policy_rules SET fence=MAX(fence,?) WHERE id=?').run(ts,ruleId)
      if (status === 'recovered') {
        db.prepare('UPDATE nw_policy_rules SET active_event=NULL,recovered_at=?,recovered_event=? WHERE id=?')
          .run(ts,id,ruleId)
      } else enqueue(id,ts)
      return record(id)
    })
  }

  function reconcileInterrupted() {
    const overdue = db.prepare("SELECT id,restart_result FROM nw_policy_events WHERE rule_id=? AND status='claimed' AND deadline<=?")
      .all(ruleId,clock())
    return overdue.map(row => finish(row.id,row.restart_result ?? 'unknown',null,'interrupted'))
  }
  async function observe(observation) {
    if (!observation || ![observation.host,observation.container,observation.probeId].every(identifier))
      throw Error('观测缺少主机、容器或业务探针')
    if (observation.host !== host || observation.container !== container || observation.probeId !== probeId)
      return {status:'manual_required', reason:'outside_scope'}
    if (!seconds(observation.sequence) || !seconds(observation.observedAt) ||
        !['ok','bad','unknown'].includes(observation.state)) throw Error('业务观测无效')
    reconcileInterrupted()
    const result = atomic(db,() => admit(observation))
    if (!result.execute) return result

    const {id,execution_id} = result.event
    const restarted = await timed(restart,execution_id)
    let event
    if (restarted === 'restarted') {
      const updated = db.prepare("UPDATE nw_policy_events SET restart_result='restarted' WHERE id=? AND status='claimed'")
        .run(id)
      if (!updated.changes) return {status:'existing',event:record(id)}
      const checked = await timed(probe,execution_id)
      const verified = checked === 'ok' || checked === 'bad' ? checked : 'unknown'
      event = finish(id,'restarted',verified,verified === 'ok' ? 'business_verified' : 'business_probe_'+verified)
    } else {
      event = finish(id,'unknown',null,'restart_unconfirmed')
    }
    return {status:event.status,event}
  }

  return {
    observe, setEnabled, reconcileInterrupted,
    rule:() => ({...target,enabled:Boolean(rule().enabled)}),
    events:() => db.prepare('SELECT id FROM nw_policy_events WHERE rule_id=? ORDER BY opened,id')
      .all(ruleId).map(({id}) => record(id)),
    notifications:() => db.prepare('SELECT event_id FROM nw_policy_notices WHERE rule_id=? AND delivered IS NULL ORDER BY created,event_id')
      .all(ruleId).map(({event_id}) => record(event_id)),
    acknowledgeNotification(id) {
      return db.prepare('UPDATE nw_policy_notices SET delivered=? WHERE rule_id=? AND event_id=? AND delivered IS NULL')
        .run(clock(),ruleId,id).changes === 1
    }
  }
}
