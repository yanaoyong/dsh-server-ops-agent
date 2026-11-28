import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { validateDuty,openDuty,dutyService,deliver,readDuty,capacityDirectoryFacts,capacityTick } from '../nightwarden-duty.js'

const exec = promisify(execFile)
const cut = Date.parse('2024-11-21T23:00:00Z')/1000
function setup(t, overrides={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nw-duty-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const config=validateDuty({host:'vps-test',container:'test-app',probeUrl:'http://127.0.0.1:19781/healthz',
    dbPath:path.join(dir,'duty.sqlite'),...overrides})
  let db=openDuty(config), now=cut-3600, health=false, free=200
  let attempts=0, checks=0
  const options={clock:()=>now,measure:async()=>({healthy:health,status:health ? 200:503,device:'demo-fs',total:1000,free,usedPct:(1000-free)/10}),
    restart:async()=>{attempts++; return 'restarted'},recheck:async()=>{checks++; return 'ok'}}
  let service=dutyService(db,config,options)
  t.after(()=>db.close())
  return {config,dir,stats:()=>({attempts,checks}),policy:()=>service.policy,view:()=>readDuty(db),
    db:()=>db, at:t=>{now=t}, tick:(time,h=health,f=free)=>{now=time;health=h;free=f;return service.tick()},
    reopen:()=>{db.close();db=openDuty(config);service=dutyService(db,config,options)}}
}

test('fixed recovery, recurrent escalation, immutable 07:00 snapshot, missing and capacity evidence',async t=>{
  const s=setup(t)
  s.policy().setEnabled(true)
  await s.tick(cut-240,false,220)
  await s.tick(cut-180,false,210)
  await s.tick(cut-120,false,200)
  await s.tick(cut-120,false,200)
  assert.deepEqual(s.stats(),{attempts:1,checks:1})
  assert.equal(s.view().deliveries.filter(row=>row.channel==='notify').length,0)
  s.reopen()
  await s.tick(cut-60,false,195)
  const notice=s.view().deliveries.filter(row=>row.channel==='notify')
  assert.equal(notice.length,1)
  assert.equal(notice[0].status,'awaiting_configuration')
  await s.tick(cut,true,180)
  const saved=s.view().reports
  assert.equal(saved.length,1)
  const [report]=saved
  assert.equal(report.until,cut)
  assert.equal(report.from,cut-86400)
  assert.equal(report.autoRecovered.length,1)
  assert.equal(report.awaitingDecision.length,1)
  assert.deepEqual(report.missing,[{from:cut-86400,until:cut-240}])
  assert.equal(report.capacity.at,cut-60)
  assert.equal(report.capacity.availableChange,-5)
  assert.equal(report.events.some(e=>e.at>=cut),false)
  await s.tick(cut+86400,true)
  assert.deepEqual(s.view().reports[1],report)
  assert.deepEqual(s.view().reports[0].missing,[{from:cut+60,until:cut+86400}])
  assert.deepEqual(s.stats(),{attempts:1,checks:1})
})

test('authenticated outbox retries in order with the original Alertmanager identity',async t=>{
  const s=setup(t)
  await s.tick(cut-180)
  await s.tick(cut-120)
  await s.tick(cut-60)
  await s.tick(cut,true)
  const c={...s.config,nightwardenUrl:'http://127.0.0.1:8080/api/alerts/ingest',notifyUrl:'https://receive.invalid/test'}
  const old=process.env.NW_ALERT_TOKEN
  t.after(()=>{if(old===undefined) delete process.env.NW_ALERT_TOKEN; else process.env.NW_ALERT_TOKEN=old})
  process.env.NW_ALERT_TOKEN='test-only'
  const calls=[]
  let fail=true
  const fetcher=async (url,options)=>{
    calls.push({url,headers:options.headers,body:JSON.parse(options.body)})
    return Response.json({received:1,stored:1,skipped:0},{status:url===c.nightwardenUrl && fail?503:200})
  }
  await deliver(s.db(),c,cut+1,fetcher)
  const first=calls.find(call=>call.url===c.nightwardenUrl)
  assert.equal(first.body.alerts[0].status,'firing')
  assert.equal(first.headers.Authorization,'Bearer test-only')
  assert.equal(calls.filter(c=>c.body.alerts?.[0].status==='resolved').length,0)
  fail=false
  s.reopen()
  await deliver(s.db(),c,cut+32,fetcher)
  await deliver(s.db(),c,cut+33,fetcher)
  const upstream=calls.filter(call=>call.url===c.nightwardenUrl)
  assert.deepEqual(upstream.map(c=>c.body.alerts[0].status),['firing','firing','resolved'])
  assert.equal(upstream[0].headers['Idempotency-Key'],upstream[1].headers['Idempotency-Key'])
  assert.equal(upstream[0].body.alerts[0].fingerprint,upstream[2].body.alerts[0].fingerprint)
  assert.equal(upstream[0].body.alerts[0].startsAt,upstream[2].body.alerts[0].startsAt)
  assert.ok(s.view().deliveries.every(row=>row.sent))
})

test('capacity threshold starts and clears a distinct read-only investigation',async t=>{
  const s=setup(t)
  await s.tick(cut-60,true,100)
  let snapshot=s.view()
  assert.equal(snapshot.capacity.availableChange,null)
  assert.equal(snapshot.events[0].kind,'firing')
  assert.ok(snapshot.events[0].event_id.startsWith('capacity-'))
  const payload=JSON.parse(s.db().prepare("SELECT body FROM duty_outbox WHERE channel='nightwarden'").get().body)
  assert.match(payload.alerts[0].annotations.description,/每小时最多一次/)
  assert.match(payload.alerts[0].annotations.description,/目录增长未知/)
  await s.tick(cut,true,250)
  snapshot=s.view()
  assert.deepEqual(snapshot.events.map(event=>event.kind),['firing','resolved'])
  assert.equal(snapshot.capacity.availableChange,150)
  assert.deepEqual(s.stats(),{attempts:0,checks:0})
})

test('capacity facts only carry verified first-level directory observations, with independent comparison times', t=>{
  const mount=fs.mkdtempSync(path.join(os.tmpdir(),'nw-directory-evidence-'))
  t.after(()=>fs.rmSync(mount,{recursive:true,force:true}))
  const directory=path.join(mount,'home')
  fs.mkdirSync(directory)
  const stat=fs.statSync(directory,{bigint:true}), device=String(stat.dev), inode=String(stat.ino)
  const row={path:directory,device,inode,points:[[100,400]]}
  const input={status:'ok',attempt:100,completed:110,rows:{[device+':'+inode+':'+directory]:row}}
  const facts=()=>capacityDirectoryFacts(input,mount,120)
  assert.deepEqual(facts(),{observedAt:100,directories:[{path:directory,bytes:400}]})
  row.points.unshift([80,300])
  assert.equal(facts().directories[0].previousBytes,300)
  row.points[0][0]=100
  assert.equal(facts().directories[0].previousAt,undefined)
  input.status='timeout'
  assert.equal(facts(),null)
  input.status='ok'
  fs.renameSync(directory,directory+'-old')
  fs.mkdirSync(directory)
  assert.equal(facts(),null)
})

test('CLI once and read use the real probe and the same persisted ledger',async t=>{
  const server=http.createServer((req,res)=>{res.writeHead(200);res.end('healthy')})
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const s=setup(t,{probeUrl:'http://127.0.0.1:'+server.address().port+'/healthz'})
  const cfg=path.join(s.dir,'config.json')
  fs.writeFileSync(cfg,JSON.stringify(s.config))
  const cli=fileURLToPath(new URL('../nightwarden-duty.js',import.meta.url))
  await exec(process.execPath,[cli,'once',cfg])
  const {stdout}=await exec(process.execPath,[cli,'read',cfg])
  const result=JSON.parse(stdout)
  assert.equal(result.device.host,'vps-test')
  assert.equal(result.rule.enabled,false)
  assert.equal(result.lastSample.http_status,200)
  assert.equal(result.lastSample.healthy,1)
  assert.deepEqual(result.deliveries,[])
})

test('one business recheck after the configured container startup grace', async t => {
  const s=setup(t,{startupGraceMs:35})
  assert.throws(()=>validateDuty({...s.config,startupGraceMs:10001}),/启动宽限/)
  let now=cut-300, restartedAt, rechecks=0
  const service=dutyService(s.db(),s.config,{
    clock:()=>now,
    restart:async()=>{restartedAt=performance.now();return 'restarted'},
    measure:async()=>{
      if (restartedAt===undefined) return {healthy:false,status:503}
      rechecks++
      const ready=performance.now()-restartedAt>=30
      return {healthy:ready,status:ready?200:503}
    }
  })
  service.policy.setEnabled(true,'test')
  for(let i=0;i<3;i++){now+=60;await service.tick()}
  assert.equal(rechecks,1)
  assert.equal(s.view().cases[0].status,'recovered')
})

test('cutoff distinguishes pending decisions from unresolved business after approval or refusal',async t=>{
  const {createNightwardenDecisions}=await import('../nightwarden-decisions.js')
  const {randomUUID}=await import('node:crypto')
  for (const choice of ['approve','reject']) for(const offset of [-1,0,1]) {
    const s=setup(t,{host:'example-host',container:'dsh-nw-rehearsal',containerId:'a'.repeat(64)})
    for(const ts of [cut-180,cut-120,cut-60])await s.tick(ts,false)
    const eventId=s.policy().events()[0].id
    let now=cut-20
    const decisions=createNightwardenDecisions(s.db(),s.config,{now:()=>now})
    const {proposal}=decisions('propose',{eventId})
    now=cut+offset
    // Even a late-generated report must project facts as of its exact cutoff.
    decisions('decide',{eventId,proposalId:proposal.id,choice,requestId:randomUUID()},'DSH:test')
    await s.tick(cut+60,false)
    const [first]=s.view().reports
    assert.deepEqual(first.awaitingDecision,offset<0?[]:[eventId])
    assert.deepEqual(first.awaitingRecovery,offset<0?[eventId]:[])
    assert.deepEqual(first.autoRecovered,[])
    const before=JSON.stringify(first)
    s.reopen()
    await s.tick(cut+86400,false)
    const [second,saved]=s.view().reports
    assert.deepEqual(second.awaitingDecision,[])
    assert.deepEqual(second.awaitingRecovery,[eventId])
    assert.equal(JSON.stringify(saved),before)
    await s.tick(cut+86460,true)
    await s.tick(cut+2*86400,true)
    assert.deepEqual(s.view().reports[0].awaitingRecovery,[])
  }
})

test('capacity-only takeover continues one alarm, ignores fixture outbox and reports independent samples',async t=>{
  const s=setup(t)
  await s.tick(cut-180,true,150)
  const initial=s.view().events.find(e=>e.kind==='firing').event_id
  const read=p=>async()=>p==null?{}:{device:'demo-fs',total:1000,free:1000-10*p,usedPct:p}
  const tick=(at,p)=>capacityTick(s.db(),s.config,()=>at,read(p))
  await tick(cut-120,86)
  await tick(cut-60,null)
  assert.equal(s.view().events.filter(e=>e.kind==='resolved').length,0)
  await tick(cut,84)
  await tick(cut,84)
  assert.deepEqual(s.view().events.map(e=>[e.event_id,e.kind]),[[initial,'firing'],[initial,'resolved']])
  const report=s.view().reports[0]
  assert.ok(!report.missing.some(g=>g.from<=cut-120 && g.until>cut-120))
  assert.ok(report.missing.some(g=>g.from<=cut-60 && g.until>cut-60))
  assert.equal(s.view().lastSample.healthy,null)
  assert.deepEqual(s.stats(),{attempts:0,checks:0})
})
