import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {openDuty,dutyService,validateDuty} from '../nightwarden-duty.js'
import {createNightwardenDecisions} from '../nightwarden-decisions.js'

async function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nw-handoff-'))
  const config=validateDuty({host:'example-host',container:'dsh-nw-rehearsal',containerId:'a'.repeat(64),
    dbPath:path.join(dir,'duty.db'),probeUrl:'http://127.0.0.1:18792/healthz',interval:60})
  const configFile=path.join(dir,'duty.json')
  fs.writeFileSync(configFile,JSON.stringify(config))
  const db=openDuty(config)
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true})})
  let now=Math.floor(Date.now()/60000)*60-240,healthy=false
  const service=dutyService(db,config,{clock:()=>now,measure:async()=>({healthy,status:healthy?200:503})})
  const tick=async health=>{healthy=health;now+=60;await service.tick()}
  await tick(false);await tick(false);await tick(false)
  const eventId=service.policy.events()[0].id
  const handle=createNightwardenDecisions(db,config,{now:()=>now})
  return {db,config,configFile,eventId,handle,tick,advance:seconds=>{now+=seconds},now:()=>now}
}

test('original proposal, authenticated once-only receipt and independent later business recovery',async t=>{
  const s=await setup(t), eventId=s.eventId
  assert.equal(s.handle('get',{eventId}).proposal,null)
  const original=s.handle('propose',{eventId})
  assert.deepEqual(s.handle('propose',{eventId:'duty:'+eventId}),original)
  assert.equal(original.proposal.action,'handoff')
  assert.equal(original.proposal.container,'dsh-nw-rehearsal')
  const request={eventId,proposalId:original.proposal.id,choice:'approve',requestId:randomUUID()}
  assert.throws(()=>s.handle('decide',{...request,actor:'DSH:spoofed'},'DSH:real'),/字段/)
  assert.throws(()=>s.handle('decide',request),/操作者/)
  const result=s.handle('decide',request,'DSH:real')
  assert.equal(result.receipt.actor,'DSH:real')
  assert.equal(result.businessRecovered,false)
  assert.equal(result.eligible,false)
  assert.equal(result.proposal.status,'approved')
  const otherDb=new DatabaseSync(s.config.dbPath)
  try {
    const reopen=createNightwardenDecisions(otherDb,s.config,{now:s.now})
    assert.deepEqual(reopen('decide',request,'DSH:real'),result)
    assert.throws(()=>reopen('decide',request,'DSH:other'),/已有决定/)
    assert.throws(()=>reopen('decide',{...request,choice:'reject'},'DSH:real'),/已有决定/)
  } finally {otherDb.close()}
  assert.equal(s.db.prepare("SELECT count(*) n FROM duty_journal WHERE kind='handoff_approved'").get().n,1)
  await s.tick(true)
  s.advance(1800)
  assert.equal(s.handle('decide',request,'DSH:real').businessRecovered,true)
  assert.deepEqual(s.handle('get',{eventId}).receipt,result.receipt)
  assert.equal(s.db.prepare('SELECT execution_id FROM nw_policy_events WHERE id=?').get(eventId).execution_id,null)
})

test('expired, superseded, recovered and out-of-scope events cannot receive an old decision',async t=>{
  const s=await setup(t), eventId=s.eventId
  const first=s.handle('propose',{eventId}).proposal
  const req={eventId,proposalId:first.id,choice:'reject',requestId:randomUUID()}
  s.advance(first.expiresAt-first.issuedAt)
  assert.equal(s.handle('get',{eventId}).proposal.status,'expired')
  assert.throws(()=>s.handle('decide',req,'DSH:operator'),/过期/)
  const second=s.handle('propose',{eventId}).proposal
  assert.equal(second.revision,2)
  assert.notEqual(second.id,first.id)
  assert.throws(()=>s.handle('decide',req,'DSH:operator'),/旧提案/)
  await s.tick(true)
  assert.equal(s.handle('get',{eventId}).proposal.status,'superseded')
  assert.throws(()=>s.handle('decide',{...req,proposalId:second.id},'DSH:operator'),/已更新/)
  assert.throws(()=>s.handle('propose',{eventId:randomUUID()}),/没有该/)
  assert.throws(()=>createNightwardenDecisions(s.db,{...s.config,container:'real-service'}),/独立演练容器/)
})

test('audit and receipt commit together, rejected handoff never marks recovery',async t=>{
  const s=await setup(t),eventId=s.eventId
  const proposal=s.handle('propose',{eventId}).proposal
  const req={eventId,proposalId:proposal.id,choice:'reject',requestId:randomUUID()}
  s.db.exec("CREATE TEMP TRIGGER simulate_receipt_error BEFORE INSERT ON duty_journal WHEN new.kind='handoff_rejected' BEGIN SELECT RAISE(ABORT,'demo write error'); END;")
  assert.throws(()=>s.handle('decide',req,'DSH:operator'),/demo write error/)
  assert.equal(s.handle('get',{eventId}).receipt,null)
  s.db.exec('DROP TRIGGER simulate_receipt_error')
  const result=s.handle('decide',req,'DSH:operator')
  assert.equal(result.proposal.status,'rejected')
  assert.equal(result.businessRecovered,false)
  assert.equal(s.handle('propose',{eventId}).receipt.id,result.receipt.id)
  assert.equal(s.db.prepare("SELECT count(*) n FROM duty_journal WHERE kind='handoff_rejected'").get().n,1)
})

test('CLI accepts the trusted SSH envelope and refuses browser-provided actor or command',async t=>{
  const s=await setup(t),eventId=s.eventId
  const cli=fileURLToPath(new URL('../nightwarden-decisions.js',import.meta.url))
  const run=(action,request,authenticatedActor)=>JSON.parse(execFileSync(process.execPath,[cli,action,s.configFile],{
    input:JSON.stringify({request,authenticatedActor}),encoding:'utf8',stdio:['pipe','pipe','pipe']}))
  const first=run('propose',{eventId})
  const req={eventId,proposalId:first.proposal.id,choice:'approve',requestId:randomUUID()}
  assert.throws(()=>run('decide',{...req,command:'ignore'},'dsh:operator'))
  assert.throws(()=>run('decide',{...req,authenticatedActor:'dsh:forged'}))
  assert.equal(run('decide',req,'dsh:operator').receipt.actor,'dsh:operator')
  assert.equal(run('get',{eventId}).proposal.status,'approved')
})
