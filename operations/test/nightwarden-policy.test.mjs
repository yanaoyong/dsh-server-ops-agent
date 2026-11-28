import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNightwardenPolicy } from '../nightwarden-policy.js'

const scope = {host:'fixture-host', container:'fixture-container-id', probeId:'fixture-business-probe'}
function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(),'ops-policy-'))
  const database = join(directory,'events.sqlite')
  const calls = {restart:[],probe:[]}
  let time = 10000
  let databaseHandle = new DatabaseSync(database)
  const options = {
    ...scope, ruleId:'fixture-rule', now:() => time,
    restart:async (...args) => { calls.restart.push(args); return 'restarted' },
    probe:async (...args) => { calls.probe.push(args); return 'ok' },
    ...overrides
  }
  let policy = createNightwardenPolicy(databaseHandle,options)
  function reopen() {
    databaseHandle.close()
    databaseHandle = new DatabaseSync(database)
    policy = createNightwardenPolicy(databaseHandle,options)
  }
  t.after(() => { databaseHandle.close(); rmSync(directory,{recursive:true,force:true}) })
  return {
    get policy() { return policy }, get db() {return databaseHandle}, calls, options, reopen,
    setTime(ts) { time=ts },
    async point(sequence,state = 'bad', extras = {}) {
      time += 1
      return policy.observe({...scope,sequence,observedAt:time,state,...extras})
    }
  }
}

test('only business observations for the immutable target qualify; successful verification is silent',async t=>{
  const s=setup(t)
  assert.equal(s.policy.rule().enabled,false)
  s.policy.setEnabled(true,'test-operator')
  for(const key of Object.keys(scope)) {
    assert.equal((await s.point(1,'bad',{[key]:'different'})).reason,'outside_scope')
  }
  assert.deepEqual(s.policy.events(),[])
  assert.equal((await s.point(1)).consecutiveFailures,1)
  assert.equal((await s.point(1)).status,'ignored')
  assert.equal((await s.point(0)).status,'ignored')
  assert.equal((await s.point(2,'unknown')).consecutiveFailures,0)
  assert.equal((await s.point(3)).consecutiveFailures,1)
  assert.equal((await s.point(5)).consecutiveFailures,1) // a missing sequence breaks the streak
  assert.equal((await s.point(6,'ok')).consecutiveFailures,0)
  assert.equal((await s.point(7)).consecutiveFailures,1)
  assert.equal((await s.point(8)).consecutiveFailures,2)
  const result=await s.point(9)
  assert.equal(result.status,'recovered')
  assert.deepEqual(result.event.samples.map(x=>x.sequence),[7,8,9])
  assert.deepEqual(s.calls.restart.map(([target,id])=>[target,id]),[[{...scope,ruleId:'fixture-rule'},result.event.execution_id]])
  assert.equal(s.calls.probe[0][1],result.event.execution_id)
  assert(Object.isFrozen(s.calls.restart[0][0]))
  s.reopen()
  assert.equal((await s.point(9)).status,'ignored')
  assert.equal(s.policy.rule().enabled,true)
  assert.equal(s.policy.events().length,1)
  assert.deepEqual(s.policy.notifications(),[])
  assert.throws(()=>createNightwardenPolicy(s.db,{...s.options,container:'other'}),/不一致/)
})

test('a recurrence within the hour immediately requests manual intervention, once, across restarts',async t=>{
  const s=setup(t)
  s.policy.setEnabled(true)
  await s.point(1); await s.point(2)
  const first=(await s.point(3)).event
  s.reopen()
  s.setTime(first.verified_at+3598)
  const recurrence=await s.point(4)
  assert.equal(recurrence.status,'manual_required')
  assert.equal(recurrence.event.reason,'recurrence')
  assert.equal(recurrence.event.related_event,first.id)
  assert.equal(recurrence.event.execution_id,null)
  for(let seq=5;seq<9;seq++) assert.equal((await s.point(seq)).event.id,recurrence.event.id)
  assert.deepEqual(s.calls.restart.length,1)
  assert.deepEqual(s.policy.notifications().map(e=>e.id),[recurrence.event.id])
  s.reopen()
  assert.equal(s.policy.acknowledgeNotification(recurrence.event.id),true)
  assert.equal(s.policy.acknowledgeNotification(recurrence.event.id),false)
  assert.deepEqual(s.policy.notifications(),[])
  assert.equal((await s.point(9,'ok')).event.status,'manual_required')
  s.setTime(s.policy.events()[1].observed_recovery+3600)
  await s.point(10); await s.point(11)
  assert.equal((await s.point(12)).status,'recovered')
  assert.equal(s.calls.restart.length,2)
})

test('disabling a rule clears its partial streak and retains human review until positive evidence',async t=>{
  const s=setup(t)
  s.policy.setEnabled(true)
  await s.point(1); await s.point(2)
  s.policy.setEnabled(false)
  assert.equal((await s.point(3)).consecutiveFailures,1)
  await s.point(4)
  const result=await s.point(5)
  assert.equal(result.event.reason,'disabled')
  s.policy.setEnabled(true)
  assert.equal((await s.point(6)).event.id,result.event.id)
  assert.equal(s.calls.restart.length,0)
  assert.equal(s.policy.notifications().length,1)
})

test('business verification failure or missing receipts escalate without a second restart',async t=>{
  for(const [restartResult,probeResult,expected,checks] of [
    ['restarted','bad','failed',1],['restarted',null,'unknown',1],[null,'ok','unknown',0],
    ['throws','ok','unknown',0],['restarted','throws','unknown',1]
  ]) {
    let restarts=0, probes=0
    const s=setup(t,{
      restart:async()=>{restarts++; if(restartResult==='throws') throw Error('not delivered'); return restartResult},
      probe:async()=>{probes++; if(probeResult==='throws') throw Error('receipt missing'); return probeResult}
    })
    s.policy.setEnabled(true)
    await s.point(1); await s.point(2)
    const result=await s.point(3)
    assert.equal(result.status,expected)
    assert.equal(s.policy.notifications()[0].id,result.event.id)
    await s.point(4)
    assert.deepEqual([restarts,probes],[1,checks])
  }
})

test('racing deliveries claim once; reconciliation of an interrupted attempt prevents replay or late overwrite',async t=>{
  let complete,started=0
  const gate=new Promise(resolve=>{complete=resolve})
  const s=setup(t,{restart:async()=>{started++;return gate}})
  s.policy.setEnabled(true)
  await s.point(1); await s.point(2)
  const pending=s.point(3)
  const other = createNightwardenPolicy(s.db,s.options)
  const row=other.events()[0]
  assert.equal(row.status,'claimed')
  assert.deepEqual(other.reconcileInterrupted(),[])
  assert.equal((await other.observe({...scope,sequence:3,observedAt:row.claimed_at,state:'bad'})).status,'ignored')
  s.setTime(row.deadline)
  assert.equal(other.reconcileInterrupted()[0].status,'unknown')
  assert.equal(other.reconcileInterrupted().length,0)
  complete('restarted')
  assert.equal((await pending).event.status,'unknown')
  assert.equal(started,1)
  assert.equal(s.calls.probe.length,0)
  s.reopen()
  assert.equal(s.policy.events().length,1)
  assert.equal(s.policy.notifications()[0].reason,'interrupted')
  assert.equal((await s.point(4)).event.id,row.id)
})

test('stale, future and delayed pre-verification samples cannot trigger a restart or a recurrence',async t=>{
  const s=setup(t)
  s.policy.setEnabled(true)
  assert.equal((await s.point(1,'bad',{observedAt:10})).status,'ignored')
  assert.equal((await s.point(1,'bad',{observedAt:50000})).reason,'outside_sample_window')
  await s.point(1)
  await s.point(2)
  s.setTime(11000) // consecutive sequence, but a long observation gap
  assert.equal((await s.point(3)).consecutiveFailures,1)
  await s.point(4)
  const first=await s.point(5)
  assert.equal(first.status,'recovered')
  assert.equal((await s.point(6,'bad',{observedAt:first.event.verified_at})).status,'ignored')
  s.setTime(first.event.verified_at+3599)
  assert.equal((await s.point(7)).consecutiveFailures,1) // exactly 3600 s after recovery
  assert.equal(s.policy.notifications().length,0)
})

test('unresponsive runner times out with unknown persisted and one notification',async t=>{
  const s=setup(t,{operationTimeoutMs:5,restart:()=>new Promise(()=>{})})
  s.policy.setEnabled(true)
  await s.point(1); await s.point(2)
  const result=await s.point(3)
  assert.equal(result.status,'unknown')
  assert.equal(result.event.restart_result,'unknown')
  assert.equal(result.event.verified_at,null)
  assert.equal(s.policy.notifications().length,1)
})
