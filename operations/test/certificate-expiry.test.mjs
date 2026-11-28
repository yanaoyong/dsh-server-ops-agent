import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLedger, reports } from '../ledger.js'
import { recordSignals } from '../signals.js'

test('certificate thresholds feed the daily snapshot and one incident per domain until renewal', t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ops-cert-'))
  const db=openLedger(dir)
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})})
  const end=Date.parse('2024-11-23T07:00:00+08:00')/1000
  const observed=end-60
  const script=fileURLToPath(new URL('../check-edge.py',import.meta.url))
  const checks=JSON.parse(execFileSync('python3',['-c',`
import json,runpy,sys
check=runpy.run_path(sys.argv[1])['certificate_result']
t=int(sys.argv[2])
print(json.dumps([check(t+seconds,t) for seconds in (14*86400+1,14*86400,3*86400+1,3*86400,0,-1,89*86400)]))`,script,String(observed)]))
  assert.deepEqual(checks.map(x=>x.facts.level),['normal','report','report','event','event','event','normal'])
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run('cert-test',end-600,'test')
  db.prepare('INSERT INTO enrolled VALUES(?)').run('cert-test')
  const key='TLS 证书 example.test'
  const record=(v,at)=>recordSignals(db,'cert-test',{[key]:v},at)
  record(checks[1],observed)
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,0)
  reports(db,end)
  const snapshot=JSON.parse(db.prepare('SELECT body FROM reports WHERE host=?').get('cert-test').body)
  assert.equal(JSON.parse(snapshot.coverage[key].last.value).level,'report')
  record(checks[3],end+1);record(checks[4],end+2)
  record({state:'unknown',facts:{}},end+3)
  assert.deepEqual(db.prepare('SELECT closed FROM cases').all().map(r=>r.closed),[null])
  record(checks[6],end+4)
  assert.equal(db.prepare('SELECT closed FROM cases').get().closed,end+4)
})
