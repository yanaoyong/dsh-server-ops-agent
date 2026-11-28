import test from 'node:test'
import assert from 'node:assert/strict'
import {checkSnapshot as verify} from '../rehearsal/check-morning-report.mjs'
const until=Date.parse('2024-11-23T07:00:00+08:00')/1000
const id='00000000-0000-4000-8000-000000000001'
const checkSnapshot = (raw, view, at) => verify(raw, view, at, {host:'example-host', day:'2024-11-23', receipt:id})
const events=[{id:'f',kind:'firing',event_id:id,at:until-900},{id:'e',kind:'escalated',event_id:id,at:until-300}]
const missing=[{from:until-86400,until:until-900}],capacity={path:'/srv/appnode',at:until-60}
const report={id:'first',host:'example-host',timezone:'Asia/Shanghai',from:until-86400,until,generated:until+15,
  events,autoRecovered:[],awaitingDecision:[id],awaitingRecovery:[],missing,capacity}
const raw={device:{host:'example-host'},events:[...events,{id:'h',kind:'handoff_approved',event_id:id,at:until}],reports:[report]}
const page={from:report.from,end:until,generated:report.generated,events:[{id:'duty:'+id}],missing,capacity}
const state={configured:true,online:true,dutyOnline:true,host:'example-host',reports:[page]}
test('first natural report excludes exact-cutoff decisions and resolves a complete DSH receipt index',()=>{
  const got=checkSnapshot(raw,state,until+300)
  assert.equal(got.reportDate,'2024-11-23')
  assert.equal(got.pendingDecision,1)
  assert.equal(got.publicationDelaySeconds,15)
  assert.throws(()=>checkSnapshot(raw,{...state,reports:[{...page,events:[]}]},until+300),/回执目录/)
  assert.throws(()=>checkSnapshot({...raw,reports:[{...report,events:raw.events}]},state,until+300),/时间线/)
  assert.throws(()=>checkSnapshot({...raw,reports:[]},state,until+300),/恰好存在一份/)
  assert.throws(()=>checkSnapshot(raw,{...state,reports:[page,page]},until+300),/恰好存在一份/)
})
