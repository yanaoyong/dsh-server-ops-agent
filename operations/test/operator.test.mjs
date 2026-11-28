import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {openLedger,observe,reports,now} from '../ledger.js'
import {overview} from '../queries.js'
import {askOperator,operatorHistory} from '../operator.js'
import {investigationEvidence,dispatch} from '../model.js'
import {modelCatalog,investigationRoute,selectModel} from '../model-routing.js'
import {summarizeDiskHistory} from '../workspace-tool.js'

test('disk history preserves its requested window and excludes unavailable samples',()=>{
  const end=86400
  const history={end,rows:[
    {ts:30,state:'ok',pct:80,bytes:3000},
    {ts:10800,state:'bad',pct:93,bytes:1000},
    {ts:14400,state:'unknown',pct:99,bytes:null},
    {ts:84000,state:'ok',pct:84,bytes:2500},
    {ts:end,state:'ok',pct:83,bytes:2600}
  ]}
  const full=summarizeDiskHistory(history,'/data',24)
  assert.equal(full.validSamples,4)
  assert.deepEqual(full.peak,{ts:10800,usedPercent:93,availableBytes:1000})
  assert.equal(full.availableChangeBytes,-400)
  assert.equal(full.longestGapSeconds,73200)
  const hour=summarizeDiskHistory(history,'/data',1)
  assert.equal(hour.start,82800)
  assert.equal(hour.hourly.length,1)
  assert.equal(hour.peak.usedPercent,84)
  assert.equal(hour.availableChangeBytes,100)
})

test('retiring a populated pilot preserves history and isolates host questions from alerts and other hosts',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ops-operator-'))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  const old=openLedger(dir,{pilot:true})
  const stamp=now()-86500
  old.prepare('UPDATE hosts SET joined=?').run(stamp)
  observe(old,'mac-pilot','代理可用性','bad',{http:502},stamp)
  reports(old);old.close()
  const db=openLedger(dir);t.after(()=>db.close())
  const archived=db.prepare("SELECT count(*) n FROM reports WHERE host='mac-pilot'").get().n
  reports(db,now()+86400)
  assert.ok(archived);assert.equal(db.prepare("SELECT count(*) n FROM reports WHERE host='mac-pilot'").get().n,archived)
  for(const id of ['vps-a','vps-b']) {
    db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(id,stamp,id)
    db.prepare('INSERT INTO enrolled VALUES(?)').run(id)
    db.prepare('INSERT INTO identities VALUES(?,?)').run(id,id)
    observe(db,id,'SSH 连接','ok',{source:'private-alias'})
  }
  const ov=overview(db)
  assert.deepEqual(ov.agentHosts,['vps-a','vps-b'])
  assert.deepEqual(ov.hosts.map(h=>h.id),ov.agentHosts)
  assert.ok(!ov.events.length && !ov.reports.length)
  const request={host:'vps-b',question:'请检查当前状态',request:randomUUID()}
  assert.throws(()=>askOperator(db,{...request,host:'mac-pilot'}))
  const {id}=askOperator(db,request)
  assert.equal(askOperator(db,request).id,id)
  assert.throws(()=>askOperator(db,{...request,question:'另一个问题'}))
  assert.equal(operatorHistory(db,'vps-a').length,0)
  await dispatch(db,async (ledger,job)=>{
    const e=investigationEvidence(ledger,job)
    assert.equal(e.host,'vps-b');assert.equal(e.observations.length,1)
    assert.ok(!JSON.stringify(e).includes('private-alias'))
    return {evidence:[e.observations[0].id],finding:'有采样',unknown:'无',next:'观察'}
  })
  assert.equal(operatorHistory(db,'vps-b')[0].evidence[0].signal,'SSH 连接')
  assert.equal(operatorHistory(db,'vps-b')[0].status,'done')
})

test('DSH-only catalog, provider/model validation, independent persistent override and reset',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ops-routing-'))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  const config=path.join(dir,'config.yml')
  const defaults={provider:'first',model:'m1'}
  const provider={apiKeyEnv:'FIXTURE_KEY',baseURL:'https://example.invalid',models:[{id:'m1'},{id:'m2'}]}
  await fs.writeFile(config,JSON.stringify([{id:'agent-default-model',config:defaults},{id:'llm-pi-ai',config:{providers:{first:provider,second:provider}}}]))
  const db=openLedger(dir);t.after(()=>db.close())
  assert.deepEqual((await investigationRoute(db,config))[0],defaults)
  const catalog=await modelCatalog(db,config)
  assert.equal(catalog.providers.length,2)
  assert.ok(!JSON.stringify(catalog).includes('FIXTURE_KEY'))
  const choice={provider:'second',model:'m2'}
  await selectModel(db,choice,config)
  await assert.rejects(selectModel(db,{provider:'second',model:'invalid'},config))
  const other=openLedger(dir);try {
    const [route,p]=await investigationRoute(other,config)
    assert.deepEqual(route,choice);assert.deepEqual(p.models,[{id:'m2'}])
  } finally {other.close()}
  await selectModel(db,null,config)
  assert.deepEqual((await investigationRoute(db,config))[0],defaults)
})

test('duty summary keeps long-running incidents visible after recent recoveries', async t=>{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ops-handover-'))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  const db = openLedger(dir)
  t.after(()=>db.close())
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run('vps-a',1,'vps-a')
  const insert = db.prepare('INSERT INTO cases(id,host,signal,opened,closed,hits) VALUES(?,?,?,?,?,1)')
  insert.run('ongoing','vps-a','容量',1,null)
  for(let n=2;n<105;n++) insert.run(String(n),'vps-a','SSH',n,n+1)
  const events = overview(db).events
  assert.deepEqual(events.filter(e=>!e.closed).map(e=>e.id),['ongoing'])
  assert.equal(events.filter(e=>e.closed).length,100)
})

test('long multiline questions and earlier chat turns survive reopen and stay scoped to the host', async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ops-chat-'))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  let db=openLedger(dir)
  for(const host of ['a','b']) {
    db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(host,1,host)
    db.prepare('INSERT INTO enrolled VALUES(?)').run(host)
    db.prepare('INSERT INTO identities VALUES(?,?)').run(host,host)
  }
  const first='诊断日志🔍\n'.repeat(600)
  for (let i=0;i<32;i++) {
    const {id}=askOperator(db,{host:'a',question:i ? '追问 '+i : first, request:randomUUID()})
    db.prepare("UPDATE investigations SET status='done',answer=? WHERE id=?").run(
      JSON.stringify({finding:'回复 '+i,evidence:[],next:'',unknown:''}),id)
  }
  askOperator(db,{host:'b',question:'隔离',request:randomUUID()})
  db.close()
  db=openLedger(dir);t.after(()=>db.close())
  const latest=operatorHistory(db,'a')
  const older=operatorHistory(db,'a',latest.at(-1).id)
  assert.equal(latest.length,30)
  assert.equal(older.length,2)
  assert.equal(older.at(-1).question,first.trim())
  const context=investigationEvidence(db,{id:latest[0].id,question:'接着聊'})
  assert.equal(context.prior.length,31)
  assert.equal(context.prior[0].question,first.trim())
  assert.equal(context.prior.at(-1).answer,'回复 30')
  assert.equal(context.earlierTurnsOmitted,false)
})

test('workspace import preserves message authors and pending questions, and appends a recovered reply once',async()=>{
  const {historySeed,workspacePath}=await import('../native-workspace.js')
  const row={id:'a',question:'先检查',ts:111,status:'retry',answer:{error:'等待重试'}}
  const initial=historySeed([row])
  assert.equal(initial.find(e=>e.surfaceOp).type,'system/message')
  assert.deepEqual(initial.find(e=>e.type==='system/message').data.message.content,[])
  assert.equal(initial.find(e=>e.type==='user/message').data.content[0].text,'先检查')
  assert.ok(!initial.some(e=>e.type==='assistant/message'))
  row.answer={finding:'已恢复',model:'m',provider:'p'}
  const later=historySeed([row],1,new Set(['user-a']))
  assert.ok(!later.some(e=>e.type==='system/message'))
  assert.ok(!later.some(e=>e.type==='user/message'))
  assert.equal(later.find(e=>e.type==='assistant/message').data.message.content[0].text,'已恢复')
  assert.equal(later[0].data.turn,2)
  assert.throws(()=>workspacePath('../other'))
})

test('lookup resolves investigations and incident evidence within the enrolled workspace host',async t=>{
  const {localRecord}=await import('../operator.js')
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ops-lookup-'))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  const db=openLedger(dir)
  t.after(()=>db.close())
  for (const host of ['a','b']) {
    db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(host,1,host)
    db.prepare('INSERT INTO enrolled VALUES(?)').run(host)
    db.prepare('INSERT INTO identities VALUES(?,?)').run(host,host)
    observe(db,host,'SSH 连接','bad',{source:'private-alias'})
  }
  const rows=db.prepare('SELECT host,id,incident FROM samples ORDER BY host').all()
  const job=db.prepare('SELECT id FROM investigations WHERE incident=?').get(rows[0].incident)
  const answer=JSON.stringify({finding:'已确认',evidence:rows.map(s=>s.id)})
  db.prepare("UPDATE investigations SET answer=?,status='done' WHERE id=?").run(answer,job.id)
  const operator=askOperator(db,{host:'a',request:randomUUID(),question:'连接情况'})
  db.prepare("UPDATE investigations SET answer=?,status='done' WHERE id=?").run(answer,operator.id)
  for (const id of [rows[0].incident, job.id, operator.id]) {
    const result=localRecord(db,'a',id)
    assert.equal(result.investigations[0].finding,'已确认')
    assert.deepEqual(result.evidence.map(s=>s.id),[rows[0].id])
    assert.deepEqual(result.investigations[0].evidence,[rows[0].id])
    assert.doesNotMatch(JSON.stringify(result),/private-alias/)
    assert.equal(localRecord(db,'b',id),null)
  }
})
