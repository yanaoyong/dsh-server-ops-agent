import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {openLedger,hash,observe,latestEnd,reports} from '../ledger.js'
import {members,prepareFixture,publishGroup,restoreGroup,groupFiles,discoverGroups} from '../groups.js'
import {collectDirectory,collectJournal,enqueueGap,directoryStats} from '../retained.js'
import {overview} from '../queries.js'

async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ops-development-')), db=openLedger(root, {pilot:true})
  t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true})})
  return {root,db}
}
test('cross-window reconnect preserves historic unknowns, ignores overlaps and advances after clipped journals',async t=>{
  const {db}=await setup(t), end=latestEnd(Date.now()/1000),host={id:'linux',alias:'fixture',machine:'test'}
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(host.id,end-86400,'fixture')
  observe(db,host.id,'可疑 IP','ok',{window_start:end-120,minute_failures:[1],window_complete:true},end-30)
  enqueueGap(db,host.id,end-120,end+120)
  reports(db,end+86400)
  const collect=async()=>({complete:true,minutes:[[end-120,1],[end-60,2],[end+60,3]]})
  await collectJournal(db,host,collect)
  enqueueGap(db,host.id,end-120,end+120)
  await collectJournal(db,host,()=>assert.fail('already processed'))
  const history=overview(db).reports.filter(r=>r.host===host.id).reverse()
  assert.deepEqual(history.map(r=>r.body.ssh_logins.failures),[3,3])
  assert.deepEqual(history.map(r=>r.body.ssh_logins.covered_minutes),[2,1])
  assert.deepEqual(history[0].body.ssh_logins.recovered,[[end-60,end]])
  assert.deepEqual(history[1].body.ssh_logins.unknown,[[end,end+60],[end+120,end+86400]])
  enqueueGap(db,host.id,end+120,end+360)
  for(let i=0;i<2;i++) await collectJournal(db,host,async()=>({complete:false,minutes:[]}))
  assert.equal(db.prepare('SELECT count(*) n FROM journal_gaps WHERE cursor<end').get().n,0)
})
test('directory growth compares real observations across a missing scan and honours inventory',async t=>{
  const {db}=await setup(t),host={id:'test'}
  db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(host.id,0,'fixture')
  db.prepare('INSERT INTO inventories VALUES(?,?,?)').run(host.id,0,JSON.stringify({sources:{'/data':{},'/tmp':{temporary_candidate:true}}}))
  for(const [stamp,bytes] of [[4000,10],[8000,null],[12000,40],[16000,50],[620000,70]]) {
    await collectDirectory(db,host,async(_,r)=>{
      assert.equal(r.source,'/data')
      assert.equal(r.seconds,[12000,16000].includes(stamp)?180:75)
      return {bytes,reason:'timeout'}
    },stamp)
    const row=directoryStats(db,host.id)[0]
    if(bytes===null) assert.equal(row.reason,'扫描超时')
    else if(stamp===12000) assert.deepEqual([row.bytes-row.previous_bytes,row.ts-row.previous_ts],[30,8000])
  }
})
test('four staged components gate publication, share packs, retry, recover catalog and restore isolated selections',async t=>{
  const {root,db}=await setup(t), folder=path.join(root,'fixture')
  const objects=new Map(),groups=new Set()
  const store={async write(k,v){const id=hash(JSON.stringify(v));objects.set(id,structuredClone(v));if(k==='group')groups.add(id);return id},
    async read(k,id){return structuredClone(objects.get(id))},async list(k){return k==='group'?[...groups]:[]}}
  await prepareFixture(folder,1)
  await fs.mkdir(path.join(folder,'base/data/empty'))
  await fs.writeFile(path.join(folder,'base/data/notes.txt'),'extra file')
  const source=path.join(folder,'base','image.test'),content=await fs.readFile(source)
  await fs.unlink(source)
  await assert.rejects(publishGroup(db,store,'vps',folder,1),/缺少/)
  assert.equal(groups.size,0)
  await fs.writeFile(source,content,{mode:0o640})
  await assert.rejects(publishGroup(db,{...store,read:async()=>({})},'vps',folder,1),/云端/)
  assert.equal(groups.size,0)
  const first=await publishGroup(db,store,'vps',folder,1)
  await fs.writeFile(path.join(folder,'base/data/site.txt'),'changed')
  const second=await publishGroup(db,store,'vps',folder,2)
  assert.equal(JSON.parse(db.prepare('SELECT body FROM group_jobs WHERE id=?').get(second.job).body).added,1)
  assert.equal((await groupFiles(db,store,'vps',first.id,'base')).length,5)
  await assert.rejects(restoreGroup(db,store,'other',first.id))
  await assert.rejects(restoreGroup(db,store,'vps',first.id,'base','../other'))
  const parent=path.join(root,'dest')
  for(const [member,file,count] of [['base','base/data/site.txt',1],['base',null,5],[null,null,17]]) {
    const r=await restoreGroup(db,store,'vps',first.id,member,file,parent)
    assert.equal(r.count,count)
    if(!file) assert.ok((await fs.stat(path.join(r.dest,'base/data/empty'))).isDirectory())
    assert.equal(await fs.readFile(path.join(r.dest,'base/data/site.txt'),'utf8'),'shared site revision 1\n')
    assert.equal((await fs.stat(path.join(r.dest,'base/data/site.txt'))).mode & 0o777,0o640)
  }
  const fresh=openLedger(path.join(root,'fresh'))
  try{assert.equal((await discoverGroups(fresh,store,'vps')).count,2)} finally{fresh.close()}
})

test('lost manifest acknowledgement blocks duplicate publication until verified cloud evidence arrives',async t=>{
  const {db,root}=await setup(t)
  const {backup,reconcileBackups}=await import('../backup.js')
  const {reconcileGroups}=await import('../groups.js')
  const objects=new Map(), catalog={version:[],group:[]}
  const store={
    async write(kind,value) {
      const id=hash(JSON.stringify(value))
      objects.set(id,structuredClone(value))
      if(kind!=='pack') {
        catalog[kind].push(id)
        throw Error('test: acknowledgement lost')
      }
      return id
    },
    async list(kind='version'){ return catalog[kind] },
    async read(kind,id){return structuredClone(objects.get(id))}
  }
  const dir=path.join(root,'fixture')
  await prepareFixture(dir,1)
  for(const group of [false,true]) {
    const publish=()=>group?publishGroup(db,store,'vps',dir,1):backup(db,store,dir)
    const reconcile=s=>group?reconcileGroups(db,s):reconcileBackups(db,s)
    const table=group?'group_jobs':'backups', versions=group?'group_versions':'versions'
    const status=()=>db.prepare('SELECT status FROM '+table).get().status
    await assert.rejects(publish(),/acknowledgement lost/)
    assert.equal(status(),'interrupted')
    await assert.rejects(publish(),/正在核对/)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,1)
    await assert.rejects(reconcile({...store,list:async()=>{throw Error('offline')}}),/offline/)
    assert.equal(status(),'interrupted')
    await assert.rejects(reconcile({...store,read:async(k,id)=>k==='pack'?{}:store.read(k,id)}))
    assert.equal(db.prepare('SELECT COUNT(*) n FROM '+versions).get().n,0)
    await reconcile(store)
    await reconcile(store)
    assert.equal(status(),'verified')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM '+versions).get().n,1)
    // A later attempt stops before the cloud accepts its manifest.
    await assert.rejects(publish(),/acknowledgement lost/)
    catalog[group?'group':'version'].pop()
    await reconcile(store)
    assert.deepEqual(db.prepare('SELECT status FROM '+table+' ORDER BY rowid').all().map(r=>r.status),['verified','failed'])
    assert.equal(db.prepare('SELECT COUNT(*) n FROM '+versions).get().n,1)
  }
})
