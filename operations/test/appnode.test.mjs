import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {openLedger} from '../ledger.js'
import {collectAppnode,businessFeedback} from '../appnode.js'

test('business samples persist once, gaps interrupt streaks, passive outages and user reports have independent lifecycles',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-business-'))
  const db=openLedger(dir)
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true})})
  const host={id:'example-host',machine:'test'}
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(host.id,0,'fixture')
  db.prepare('INSERT INTO identities VALUES(?,?)').run(host.id,host.machine)
  db.prepare('INSERT INTO enrolled VALUES(?)').run(host.id)
  db.prepare('INSERT INTO inventories VALUES(?,?,?)').run(host.id,0,JSON.stringify({containers:[{name:'appnode',observed:true}]}))
  let rows=[]
  const collect=()=>collectAppnode(db,host,async(_,r)=>rows.filter(([t])=>t>r.after))
  const cases=()=>db.prepare('SELECT signal,closed FROM cases ORDER BY opened').all()
  const sample=(t,share)=>[t,{web:200,engine:200,secondary:0,share,watch:10}]
  rows=[sample(60,0),sample(120,0),sample(240,0),sample(300,0)]
  await collect();assert.equal(cases().length,0)
  rows.push(sample(360,0));await collect()
  assert.equal(cases().length,1);assert.match(cases()[0].signal,/文件分享/)
  const sampleCount=()=>db.prepare('SELECT COUNT(*) n FROM samples').get().n
  const count=sampleCount();await collect();assert.equal(sampleCount(),count)
  rows.push(sample(420,null));await collect();assert.equal(cases()[0].closed,null)
  businessFeedback(db,{host:host.id,component:'share',recovered:false})
  rows.push(sample(480,404));await collect()
  assert.equal(cases()[0].closed,480);assert.equal(cases()[1].closed,null)
  businessFeedback(db,{host:host.id,component:'share',recovered:true})
  assert.ok(cases()[1].closed)
})
