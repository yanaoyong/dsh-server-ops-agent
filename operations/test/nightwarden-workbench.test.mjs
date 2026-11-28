import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {createNightWardenWorkbench} from '../nightwarden-workbench.js'
import {NightWardenError} from '../nightwarden-client.js'
import {dutyView} from '../nightwarden-remote.js'

const event={sessionId:'s',title:'业务探针',status:'completed',lastActivityAt:'2024-11-22T01:00:00Z',awaitingHumanInput:false}
const duty={device:{host:'h',container:'fixture'},rule:{ruleId:'r',enabled:true},deliveries:[],cases:[],
  events:[{event_id:'p',kind:'firing',at:11,detail:'收到告警'}],
  reports:[{until:60,from:0,generated:65,events:[{event_id:'p'}],missing:[{from:0,until:60}],
    autoRecovered:[],awaitingDecision:[],capacity:null}]}
function setup(t) {
  const db=new DatabaseSync(':memory:')
  t.after(()=>db.close())
  db.exec("CREATE TABLE workbench_hosts(id TEXT);INSERT INTO workbench_hosts VALUES('h')")
  const remote={status:200,running:false,disabled:0,sent:[]}
  function check() {if(remote.status!==200) throw new NightWardenError(remote.status,'error')}
  const config={host:'h',baseUrl:'http://127.0.0.1:3000',cookie:'scoped',instance:'unit'}
  const client={
    listSessions:async()=>{check();return {rows:[event],nextOffset:null}},
    session:async()=>{check();return {...event,running:remote.running,alerts:remote.alerts || [{alert:{labels:{instance:'h',dsh_event_id:'p'}}}],
      transcript:[{kind:'agent_text',text:'password=example'}]}},
    report:async()=>remote.report || null,
    appendMessage:async(id,text)=>remote.sent.push({id,...text})
  }
  const nw=createNightWardenWorkbench(db,{loadConfig:async()=>config,createClient:()=>client,
    readDuty:async()=>duty,disableDuty:async()=>remote.disabled++,now:()=>42})
  return {nw,remote,config}
}
test('a duty report links a receipt to the original investigation; details, workspace and history survive a network outage',async t=>{
  const {nw,remote}=setup(t)
  const first=await nw('nw-overview')
  assert.equal(first.online,true);assert.equal(first.dutyOnline,true)
  assert.match(first.reports[0].summary,/缺测 1 分钟/)
  const id=first.reports[0].events[0].id
  assert.equal((await nw('nw-event',{id})).linkedId,'s')
  const link=await nw('nw-workspace-link',{id:'s'})
  assert.deepEqual(await nw('nw-workspace-link',{id:'s'}),link)
  remote.status=502
  const offline=await nw('nw-overview')
  assert.equal(offline.online,false);assert.equal(offline.dutyOnline,true);assert.equal(offline.lastSync,42)
  const detail=await nw('nw-workspace-evidence',{session:link.session})
  assert.equal(detail.online,false);assert.equal(detail.nativeUrl,null);assert.doesNotMatch(detail.messages[0],/example/)
  remote.status=403
  await assert.rejects(nw('nw-overview'),/权限/)
  remote.status=502
  assert.deepEqual((await nw('nw-overview')).events.map(x=>x.id),['duty:p'])
})
test('mutations use current rule and event, never replay or submit arbitrary IDs',async t=>{
  const {nw,remote}=setup(t)
  await nw('nw-overview')
  await assert.rejects(nw('nw-disable',{ruleId:'old'}),/刷新/)
  await nw('nw-disable',{ruleId:'r'});assert.equal(remote.disabled,1)
  await assert.rejects(nw('nw-question',{id:'other',message:'hello'}),/本主机/)
  await assert.rejects(nw('nw-question',{id:'duty:p',message:'hello'}),/关联/)
  remote.running=true
  await assert.rejects(nw('nw-question',{id:'s',message:'原问题'}),/调查正在运行/)
  assert.equal(remote.sent.length,0)
})
test('reject duty data for another host',()=>{
  assert.throws(()=>dutyView(duty,'other'))
})

test('capacity summaries require comparable collection times before reporting a directory change',async t=>{
  const {nw,remote}=setup(t)
  const annotations={summary:'可用空间低于阈值'}
  remote.alerts=[{alert:{labels:{instance:'h',mountpoint:'/srv/appnode',alertname:'DSHFilesystemCapacity',dsh_event_id:'capacity-01'},annotations}}]
  remote.report={record:{report:{summary:'六小时无增长，采集器过期'}},evidence:[]}
  await nw('nw-overview')
  const summary=async()=>(await nw('nw-event',{id:'s'})).summary
  assert.match(await summary(),/增长待核实/)
  assert.doesNotMatch(await summary(),/六小时|过期/)
  const dir={path:'/srv/appnode/workspace',bytes:405,previousAt:2000,previousBytes:400}
  const facts={observedAt:2000,directories:[dir]}
  annotations.dsh_directory_facts=JSON.stringify(facts)
  assert.match(await summary(),/占用 405 字节，只有一次/)
  dir.previousAt=1000
  annotations.dsh_directory_facts=JSON.stringify(facts)
  assert.match(await summary(),/变化 \+5 字节/)
  facts.directories.push(dir)
  annotations.dsh_directory_facts=JSON.stringify(facts)
  assert.doesNotMatch(await summary(),/变化 \+5/)
  assert.match(await summary(),/待核实/)
})

test('workspace record lookup scopes both investigations and receipts to the host without rebinding',async t=>{
  const {nw,remote}=setup(t)
  await nw('nw-overview')
  const link=await nw('nw-workspace-link',{id:'s'})
  assert.equal(await nw('nw-record',{host:'other',id:'s'}),null)
  assert.equal(await nw('nw-record',{host:'h',id:'absent'}),null)
  assert.equal((await nw('nw-record',{host:'h',id:'s'})).id,'s')
  assert.equal((await nw('nw-record',{host:'h',id:'p'})).id,'duty:p')
  assert.equal((await nw('nw-workspace-evidence',{session:link.session})).id,'s')
  remote.alerts=[{alert:{labels:{instance:'elsewhere'}}}]
  assert.equal(await nw('nw-record',{host:'h',id:'s'}),null)
  remote.status=502
  assert.equal(await nw('nw-record',{host:'h',id:'s'}),null)
})
