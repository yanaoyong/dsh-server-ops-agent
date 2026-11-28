import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {root,privateDir} from './paths.js'
import {snapshot} from './backup.js'
import {hash,now,atomic} from './ledger.js'

export const members = ['base','appnode','example-gateway','example-site']
const roles = ['definition.json','image.test','layer.test','data/site.txt']
const scope = 'mac-four-container-fixture-v1'
const hex = /^[a-f0-9]{64}$/

export function groupState(db) {
  const versions=db.prepare('SELECT id,host,ts,manifest FROM group_versions ORDER BY ts DESC,rowid DESC LIMIT 100').all()
    .map(({manifest,...row})=>({...row,members:JSON.parse(manifest).members,revision:JSON.parse(manifest).revision}))
  const jobs=db.prepare('SELECT * FROM group_jobs ORDER BY ts DESC,rowid DESC LIMIT 100').all()
    .map(({body,...row})=>({...row,...JSON.parse(body)}))
  return {versions,jobs}
}
export async function prepareFixture(folder,revision) {
  for (const member of members) {
    const dir=path.join(folder,member)
    await fs.mkdir(path.join(dir,'data'),{recursive:true,mode:0o700})
    const files={
      'definition.json': JSON.stringify({fixture:true,name:member,network:'isolated-test',architecture:'x86_64'}),
      'image.test': 'fixture image '+(member.endsWith('caddy') || member==='example-site'?'shared-caddy':member),
      'layer.test': 'fixture layer '+member,
      'data/site.txt': (member==='base' || member==='example-site'?'shared site':member)+' revision '+revision+'\n'
    }
    for(const [name,data] of Object.entries(files)) {
      await fs.writeFile(path.join(dir,name),data,{flag:'wx',mode:0o640})
      await fs.chmod(path.join(dir,name),0o640)
    }
  }
}
function checkManifest(m,host) {
  if (m.scope!==scope || m.host!==host || !Number.isSafeInteger(m.revision) || m.revision<1 ||
      JSON.stringify(m.members)!==JSON.stringify(members) || !Array.isArray(m.files) || !Array.isArray(m.dirs))
    throw Error('测试组清单无效')
  const required = new Set(members.flatMap(member=>roles.map(role=>member+'/'+role)))
  const names = new Set()
  const dirs=new Set(members.flatMap(member=>[member,member+'/data']))
  function validMode(x) {
    return Number.isInteger(x.mode) && x.mode>=0 && x.mode<=0o777 && Number.isSafeInteger(x.uid) && x.uid>=0 && Number.isSafeInteger(x.gid) && x.gid>=0
  }
  function checkPath(entry) {
    if(typeof entry.name!=='string' || names.has(entry.name) || !validMode(entry)) throw Error('条目或权限无效')
    const parts=entry.name.split('/')
    if(!members.includes(parts[0]) || parts.some(p=>!p || p==='.' || p==='..' || p.includes('\0'))) throw Error('组内路径无效')
    names.add(entry.name)
    return parts
  }
  const folders=new Set()
  for(const d of m.dirs) {
    const parts=checkPath(d)
    if(parts.length>1 && parts[1]!=='data') throw Error('目录超出组范围')
    dirs.delete(d.name)
    folders.add(d.name)
  }
  for(const f of m.files) {
    const parts=checkPath(f)
    if(!hex.test(f.sha) || !hex.test(f.pack) || (!required.delete(f.name) && !(parts.length>2 && parts[1]==='data')))
      throw Error('文件引用无效')
  }
  if (required.size || dirs.size) throw Error('缺少组内必需组件')
  for(const name of names) if(name.includes('/') && !folders.has(path.posix.dirname(name))) throw Error('缺少父目录')
}
async function readObjects(store,files) {
  const packs=new Map(),contents=new Map()
  for(const f of files) {
    if(!packs.has(f.pack)) packs.set(f.pack,await store.read('pack',f.pack))
    const encoded=packs.get(f.pack)?.[f.sha]
    if(typeof encoded!=='string') throw Error('缺少云端数据')
    if(!contents.has(f.sha)) {
      const bytes=Buffer.from(encoded,'base64')
      if(hash(bytes)!==f.sha) throw Error('云端文件摘要不符')
      contents.set(f.sha,bytes)
    } else if(contents.get(f.sha).toString('base64')!==encoded) throw Error('云端文件摘要不符')
  }
  return contents
}
function receipt(db,host,operation) {
  const id=randomUUID(), body={operation,components:Object.fromEntries(members.map(n=>[n,'待处理']))}
  const save=(status,extra={})=>{
    Object.assign(body,extra)
    db.prepare('INSERT INTO group_jobs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body')
      .run(id,host,now(),status,JSON.stringify(body))
  }
  save('running')
  return {id,body,save}
}
export async function publishGroup(db,store,host,folder,revision) {
  if (db.prepare("SELECT 1 FROM group_jobs WHERE host=? AND status='interrupted' AND json_extract(body,'$.operation')='测试组备份' LIMIT 1").get(host))
    throw Error('上一次测试组备份正在核对云端回执')
  const job=receipt(db,host,'测试组备份')
  let publishing=false
  try {
    const snap=await snapshot(folder)
    for(const member of members) {
      const present=new Set(snap.files.map(f=>f.name))
      const missing=roles.filter(role=>!present.has(member+'/'+role))
      job.body.components[member]=missing.length?'缺少 '+missing.join('、'):'采集完成'
    }
    job.save('running')
    if(Object.values(job.body.components).some(s=>s!=='采集完成')) throw Error('缺少组内必需组件')
    const previous=db.prepare('SELECT manifest FROM group_versions WHERE host=? ORDER BY ts DESC,rowid DESC LIMIT 1').get(host)
    const refs=new Map(previous?JSON.parse(previous.manifest).files.map(f=>[f.sha,f.pack]):[])
    const fresh=[...snap.objects].filter(([sha])=>!refs.has(sha))
    if(fresh.length) {
      const pack=await store.write('pack',Object.fromEntries(fresh))
      for(const [sha] of fresh) refs.set(sha,pack)
    }
    const manifest={scope,host,revision,job:job.id,ts:now(),members,
      dirs:snap.dirs.map(name=>({name,...snap.metadata[name]})),
      files:snap.files.map(f=>({...f,...snap.metadata[f.name],pack:refs.get(f.sha)}))}
    checkManifest(manifest,host)
    await readObjects(store,manifest.files)
    for(const c of members) job.body.components[c]='云端数据回读通过'
    job.save('running',{added:fresh.length,reused:manifest.files.length-fresh.length})
    publishing=true
    const id=await store.write('group',manifest)
    if(!hex.test(id) || JSON.stringify(await store.read('group',id))!==JSON.stringify(manifest)) throw Error('云端组清单不符')
    atomic(db,()=>{
      db.prepare('INSERT INTO group_versions VALUES(?,?,?,?)').run(id,host,manifest.ts,JSON.stringify(manifest))
      job.save('verified',{version:id,added:fresh.length,reused:manifest.files.length-fresh.length})
    })
    return {id,job:job.id}
  } catch(e) {
    job.save(publishing?'interrupted':'failed',{reason:publishing?'等待核对云端清单':e.message})
    throw e
  }
}
export async function publishFixture(db,store,host) {
  const revision=db.prepare('SELECT COUNT(*)+1 n FROM group_versions WHERE host=?').get(host).n
  const folder=await fs.mkdtemp(path.join(root,'group-fixture-'))
  try { await prepareFixture(folder,revision);return await publishGroup(db,store,host,folder,revision) }
  finally { await fs.rm(folder,{recursive:true,force:true}) }
}
async function loadGroup(db,store,host,id) {
  if(!hex.test(id) || !db.prepare('SELECT 1 FROM group_versions WHERE host=? AND id=?').get(host,id)) throw Error('请选择本主机测试版本')
  const manifest=await store.read('group',id)
  checkManifest(manifest,host)
  return manifest
}
export async function groupFiles(db,store,host,id,member) {
  if(!members.includes(member)) throw Error('请选择已登记容器')
  return (await loadGroup(db,store,host,id)).files.filter(f=>f.name.startsWith(member+'/')).map(({name,mode,sha,uid,gid})=>({name,mode,sha,uid,gid}))
}
export async function restoreGroup(db,store,host,id,member=null,file=null,parent=path.join(root,'group-restores')) {
  if(member!==null && !members.includes(member) || file!==null && (!member || typeof file!=='string')) throw Error('恢复选择无效')
  const m=await loadGroup(db,store,host,id)
  const files=m.files.filter(f=>(!member || f.name.startsWith(member+'/')) && (!file || f.name===file))
  if(!files.length || file!==null && files.length!==1) throw Error('指定文件不在所选容器中')
  const job=receipt(db,host,'测试组恢复')
  for(const c of members) job.body.components[c]=!member || member===c?'待回读':'未选择'
  let tmp
  try {
    const data=await readObjects(store,files)
    privateDir(parent)
    tmp=await fs.mkdtemp(path.join(parent,'.partial-'))
    const dirs=m.dirs.filter(d=>file ? file.startsWith(d.name+'/') : !member || d.name===member || d.name.startsWith(member+'/')).sort((a,b)=>a.name.length-b.name.length)
    for(const d of dirs) await fs.mkdir(path.join(tmp,d.name),{recursive:true,mode:0o700})
    for(const f of files) {
      const dest=path.join(tmp,f.name)
      await fs.writeFile(dest,data.get(f.sha),{flag:'wx'})
      await fs.chmod(dest,f.mode)
      if(hash(await fs.readFile(dest))!==f.sha || ((await fs.stat(dest)).mode & 0o777)!==f.mode) throw Error('恢复校验失败')
    }
    for(const d of dirs.reverse()) await fs.chmod(path.join(tmp,d.name),d.mode)
    const dest=path.join(parent,'restore-'+job.id)
    await fs.rename(tmp,dest);tmp=null
    for(const c of new Set(files.map(f=>f.name.split('/')[0]))) job.body.components[c]='恢复摘要与权限通过'
    job.save('restored',{version:id,dest,files:files.map(f=>({name:f.name,sha:f.sha}))})
    return {dest,count:files.length,job:job.id}
  } catch(e) {job.save('failed',{reason:e.message});throw e}
  finally {if(tmp) await fs.rm(tmp,{force:true,recursive:true})}
}

function recordGroup(db,id,m) {
  atomic(db,()=>{
    db.prepare('INSERT OR IGNORE INTO group_versions VALUES(?,?,?,?)').run(id,m.host,m.ts,JSON.stringify(m))
    const job=db.prepare('SELECT body FROM group_jobs WHERE id=? AND host=?').get(m.job,m.host)
    if (!job) return
    const body=JSON.parse(job.body)
    if (body.operation!=='测试组备份') return
    delete body.reason
    body.version=id
    body.reconciled=true
    body.components=Object.fromEntries(members.map(name=>[name,'云端数据回读通过']))
    db.prepare("UPDATE group_jobs SET status='verified',body=? WHERE id=?").run(JSON.stringify(body),m.job)
  })
}
export async function reconcileGroups(db,store) {
  const jobs=db.prepare("SELECT id,host FROM group_jobs WHERE status='interrupted' AND json_extract(body,'$.operation')='测试组备份'").all()
  if (!jobs.length) return
  const pending=new Map(jobs.map(j=>[j.id,j.host]))
  for (const id of await store.list('group')) {
    const m=await store.read('group',id)
    if (!pending.has(m.job) || pending.get(m.job)!==m.host || m.scope!==scope) continue
    checkManifest(m,m.host)
    await readObjects(store,m.files)
    recordGroup(db,id,m)
    pending.delete(m.job)
  }
  for (const job of pending.keys()) {
    db.prepare("UPDATE group_jobs SET status='failed',body=json_set(body,'$.reason','云端对账未发现已发布组版本') WHERE id=? AND status='interrupted'").run(job)
  }
}

export async function discoverGroups(db,store,host) {
  let count=0
  for(const id of await store.list('group')) {
    if(!hex.test(id)) throw Error('云端组编号无效')
    const m=await store.read('group',id)
    if(m.host!==host || m.scope!==scope) continue
    checkManifest(m,host)
    await readObjects(store,m.files)
    recordGroup(db,id,m)
    count++
  }
  return {count}
}
