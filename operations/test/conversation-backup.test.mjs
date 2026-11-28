import assert from 'node:assert/strict'
import test from 'node:test'
import {registerConversationBackup} from '../conversation-backup.js'
import {apply} from '../workspace-tool.js'

const now=Math.floor(Date.now()/1000), latest=now-3600, older=now-90_000
function fixture(overrides={}) {
  const tools=new Map(), calls=[]
  const history={points:[{point:latest,baidu:true,google:false},{point:older,baidu:true,google:true}],
    jobs:[{directory:'another-session-private-path'}],capture:{status:'sealed',started:latest}}
  const google={started:older,connected:true,active:false,progress:{phase:'等待重试'}}
  const routes={'google-history-points':()=>history,'google-status':()=>google,
    'google-history-capture':()=>({submitted:true}),'google-retry':()=>({}),...overrides}
  const exec={agent:{id:'session',session:{header:{cwd:'/vps'}}},signal:new AbortController().signal}
  const ctx={tools:{register:t=>tools.set(t.name,t)}}
  registerConversationBackup(ctx,async(action,data)=>{
    calls.push(action)
    assert.equal(data.host,'example-host')
    return routes[action](data)
  },cwd=>({host:cwd==='/vps'?'example-host':'other'}))
  return {calls,history,google,exec,run:(name,args={})=>tools.get(name).execute(args,exec)}
}
test('backup status uses individual data times, partial receipts, and requires the enrolled workspace',async()=>{
  const f=fixture()
  let status=await f.run('read_workspace_backup')
  assert.deepEqual([status.latestLocal,status.latestBaidu,status.latestGoogle,status.offsite24h],[latest,latest,older,'met'])
  assert.ok(!JSON.stringify(status).includes('another-session-private-path'))
  f.history.points[0].baidu=false
  assert.equal((await f.run('read_workspace_backup')).offsite24h,'unmet')
  const partial=fixture({'google-status':()=>{throw Error('offline')}})
  partial.history.points[0].baidu=false
  status=await partial.run('read_workspace_backup')
  assert.equal(status.offsite24h,'unknown')
  assert.deepEqual(status.unavailable,['google_status'])
  f.exec.agent.session.header.cwd='/other'
  const calls=f.calls.length
  await assert.rejects(f.run('start_workspace_backup'),/example-host/)
  assert.equal(f.calls.length,calls)
})
test('start, follow and refresh pin the first new point while later captures arrive',async()=>{
  const f=fixture()
  const receipt=await f.run('start_workspace_backup')
  assert.equal(receipt.status,'requested')
  assert.deepEqual(receipt,JSON.parse(JSON.stringify(receipt)))
  const first=latest+50
  f.history.points.unshift({point:first,baidu:false,google:false})
  f.google.progress={}
  let check=await f.run('follow_workspace_backup',{...receipt.follow,waitSeconds:0})
  assert.equal(check.status,'pending')
  assert.equal(check.follow.point,first)
  f.history.points.unshift({point:first+50,baidu:true,google:true})
  check=await f.run('follow_workspace_backup',{...check.follow,waitSeconds:0})
  assert.equal(check.status,'pending')
  f.history.points[1].google=f.history.points[1].baidu=true
  check=await f.run('follow_workspace_backup',{...check.follow,waitSeconds:0})
  assert.equal(check.status,'complete')
  assert.deepEqual(f.calls.filter(x=>x==='google-history-capture'),['google-history-capture'])
})
test('retry reuses the upload queue and an active transfer or prior receipt causes zero submissions',async()=>{
  const f=fixture()
  f.google.active=true
  assert.equal((await f.run('retry_workspace_google')).status,'already_in_progress')
  assert.equal((await f.run('retry_workspace_google',{point:older})).status,'already_verified')
  assert.ok(!f.calls.includes('google-retry'))
  f.google.active=false
  const retry=await f.run('retry_workspace_google')
  assert.deepEqual(retry.follow,{point:latest,goal:'google'})
  f.google.connected=false
  assert.equal((await f.run('follow_workspace_backup',{...retry.follow,waitSeconds:0})).status,'connection_required')
  assert.equal(f.calls.filter(x=>x==='google-retry').length,1)
  assert.ok(!f.calls.includes('google-history-capture'))
})
test('lookup without receipts cannot submit and a lost submission response only offers read-only follow-up',async()=>{
  const f=fixture({'google-history-points':()=>{throw Error('offline')}})
  assert.equal((await f.run('start_workspace_backup')).status,'unknown')
  assert.ok(!f.calls.includes('google-history-capture'))
  const lost=fixture({'google-history-capture':()=>{throw Error('lost response')}})
  const receipt=await lost.run('start_workspace_backup')
  assert.equal(receipt.status,'submission_unknown')
  assert.equal((await lost.run('follow_workspace_backup',{...receipt.follow,waitSeconds:0})).status,'pending')
})
test('native preset allows the registered workspace backup tools',()=>{
  let allow,guard
  apply({tools:{guard:fn=>guard=fn,register(){}},inject(){},systemPrompt:{section(){}},
    on:(_,fn)=>fn({agent:{ctx:{tools:{restrict:options=>{allow=options.allow}}}}})})
  for(const name of ['read_workspace_backup','follow_workspace_backup','start_workspace_backup',
    'retry_workspace_google','browse_workspace_backup']) {
    assert.ok(allow.includes(name))
    assert.equal(guard({name}),undefined)
  }
  assert.ok(guard({name:'shell'}))
})
