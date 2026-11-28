import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createNightWardenClient, NightWardenError } from './nightwarden-client.js'
import { root } from './paths.js'
import { remoteDuty, dutyView } from './nightwarden-remote.js'
import { redact } from './redact.js'

const clean = (value, max = 1800) => redact(String(value ?? '')).slice(0, max)
const stamp = value => Math.floor(Date.parse(value) / 1000) || null

async function privateConfig(filename) {
  let file
  try {
    file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 32768)
      throw Error('请核对值班连接配置的属主和权限')
    return JSON.parse(await file.readFile('utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw Error('值班连接配置不可用')
  } finally {
    await file?.close()
  }
}

function summary(row) {
  return {id:row.sessionId,title:clean(row.title,280),status:row.status || 'not_started',
    needsDecision:row.awaitingHumanInput,updated:stamp(row.lastActivityAt)}
}

function capacitySummary(alerts, host) {
  const capacity = alerts.map(row=>row.alert).filter(({labels})=>
    labels?.instance===host && labels.mountpoint==='/srv/appnode' &&
    ['DSHFilesystemCapacity','DSHReadOnlyAcceptanceFilesystemAvailableBelow5GiB'].includes(labels.alertname))
  if (!capacity.length) return null
  const alert=capacity.at(-1)
  const heading=clean(alert.annotations?.summary || '/srv/appnode 容量告警',300)
  const unknown=heading+'\n告警记录中缺少可比较的目录采样，目录增长待核实。'
  let facts
  try { facts=JSON.parse(alert.annotations?.dsh_directory_facts) } catch { return unknown }
  const {observedAt,directories}=facts || {}
  const validTime=t=>Number.isSafeInteger(t) && t>0 && t<253402300800
  const validBytes=n=>Number.isSafeInteger(n) && n>=0
  if (!validTime(observedAt) || !Array.isArray(directories) || !directories.length || directories.length>30) return unknown
  const seen=new Set(), lines=[]
  const when=t=>new Date(t*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})
  for (const dir of directories) {
    if (!dir || typeof dir.path!=='string' || !/^\/srv\/appnode\/[^\/\p{Cc}]+$/u.test(dir.path) ||
        ['.','..'].includes(path.basename(dir.path)) || seen.has(dir.path) || !validBytes(dir.bytes)) return unknown
    seen.add(dir.path)
    let change='只有一次可用采样，增长待核实'
    if (validTime(dir.previousAt) && dir.previousAt<observedAt && validBytes(dir.previousBytes)) {
      const delta=dir.bytes-dir.previousBytes
      change='较 '+when(dir.previousAt)+' 变化 '+(delta>0?'+':'')+delta+' 字节'
    }
    lines.push(clean(dir.path,300)+' 占用 '+dir.bytes+' 字节，'+change)
  }
  return [heading,'目录采样时间 '+when(observedAt)+'（北京时间）',...lines].join('\n')
}

function detail(row, record, item, host) {
  const report = record?.record.report
  const messages = row.transcript.filter(t=>['user_turn','agent_text','error_text'].includes(t.kind))
    .map(t=>({user_turn:'提问',agent_text:'调查',error_text:'异常'}[t.kind]+' · '+clean(t.text)))
  const samples = row.alerts.map(({alert,arrivedAt})=>[arrivedAt,alert.alertType,
    clean(alert.annotations?.summary || alert.labels?.alertname)].filter(Boolean).join(' · '))
  return {...item,updated:stamp(row.lastActivityAt),status:row.running?'running':item.status,
    needsDecision:row.transcript.some(t=>t.state?.phase==='awaiting_human') || item.needsDecision,
    summary:capacitySummary(row.alerts,host) ?? clean(report?.summary || (row.running?'服务器正在调查':'尚无调查结论')),
    evidence:[...samples,...(record?.evidence || []).map(e=>clean(e.evidenceId+' · '+e.toolName+' · '+e.result))],
    messages}
}

export function createNightWardenWorkbench(db, {
  configPath=path.join(root,'nightwarden.json'), loadConfig=()=>privateConfig(configPath),
  remoteDecision=(config,action,payload)=>remoteDuty(db,config.host,action,null,payload),
  createClient=createNightWardenClient, readDuty=config=>remoteDuty(db,config.host), disableDuty=(config,id)=>remoteDuty(db,config.host,'disable',id), now=()=>Math.floor(Date.now()/1000)
}={}) {
  db.exec('CREATE TABLE IF NOT EXISTS nw_cache(scope TEXT,slot TEXT,body TEXT NOT NULL,PRIMARY KEY(scope,slot))')
  db.exec('CREATE TABLE IF NOT EXISTS nw_workspace(session TEXT PRIMARY KEY,scope TEXT NOT NULL,event TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS nw_questions(scope TEXT,request TEXT,event TEXT,digest TEXT,status TEXT,PRIMARY KEY(scope,request))')
  const get=db.prepare('SELECT body FROM nw_cache WHERE scope=? AND slot=?')
  const put=db.prepare('INSERT OR REPLACE INTO nw_cache(scope,slot,body) VALUES(?,?,?)')
  const remove=db.prepare('DELETE FROM nw_cache WHERE scope=?')
  const cached=(scope,slot)=>{
    const row=get.get(scope,slot)
    if (!row) return null
    const value=JSON.parse(row.body)
    if (!value.capacitySummaryVerified && value.dutyIds?.some(id=>id.startsWith('duty:capacity-'))) {
      value.summary='/srv/appnode 的历史目录采样待同步，目录增长待核实。'
    }
    return value
  }
  const save=(scope,slot,body)=>put.run(scope,slot,JSON.stringify(body))
  const inflight=new Map()
  return async function handle(action,data={}) {
    const config=await loadConfig()
    if (!config) {
      if (action==='nw-record') return null
      if (action!=='nw-overview') throw Error('服务器值班尚未接入')
      return {configured:false,online:false,host:null,lastSync:null,events:[],reports:[]}
    }
    if (action==='nw-record' && data.host!==config.host) return null
    if (!config.instance || !config.host || !config.cookie || !db.prepare(
      'SELECT 1 FROM workbench_hosts WHERE id=?').get(config.host)) throw Error('请核对值班实例与登记主机')
    const base=new URL(config.baseUrl)
    const scope=createHash('sha256').update(JSON.stringify([config.host,config.instance,base.origin,config.cookie])).digest('hex')
    const client=createClient(config)
    const workspaceId=id=>'session-ops-nw-'+createHash('sha256').update(JSON.stringify([config.host,config.instance,base.origin,id])).digest('hex').slice(0,32)
    function fail(error) {
      if (error.status===401 || error.status===403) {
        remove.run(scope)
        throw Error('服务器值班身份已失效或权限不足')
      }
      if (error.status===404) throw Error('服务器上找不到这项调查')
    }
    async function fetchDetail(item) {
      const [row,record]=await Promise.all([client.session(item.id),client.report(item.id)])
      const event=detail(row,record,item,config.host)
      event.singleHostVerified=row.alerts.length>0 && row.alerts.every(a=>a.alert.labels?.instance===config.host)
      event.capacitySummaryVerified=true
      event.dutyIds=row.alerts.filter(a=>a.alert.labels?.instance===config.host && a.alert.labels?.dsh_event_id)
        .map(a=>'duty:'+a.alert.labels.dsh_event_id)
      save(scope,'event:'+item.id,event)
      return event
    }
    const home=()=>cached(scope,'overview') || {host:config.host,lastSync:null,events:[],reports:[]}
    async function overview() {
      const previous=home()
      const [source,backend]=await Promise.allSettled([readDuty(config).then(raw=>dutyView(raw,config.host)), listRemote()])
      async function listRemote() {
        const items=new Map()
        let offset=0
        do {
          const page=await client.listSessions({limit:100,offset})
          for(const row of page.rows) items.set(row.sessionId,summary(row))
          offset=page.nextOffset
        } while(offset!==null)
        return [...items.values()]
      }
      const online=backend.status==='fulfilled', dutyOnline=source.status==='fulfilled'
      if(!online) fail(backend.reason)
      const remote=online?backend.value:previous.events.filter(e=>!e.id.startsWith('duty:'))
      const duty=dutyOnline?source.value:null
      const receipts=duty?.items || previous.events.filter(e=>e.id.startsWith('duty:'))
      if(duty) for(const e of receipts) save(scope,'event:'+e.id,e)
      const related=new Map()
      for(const item of remote) {
        let event=cached(scope,'event:'+item.id)
        const refreshCapacity=event && !event.capacitySummaryVerified && event.dutyIds?.some(id=>id.startsWith('duty:capacity-'))
        if(online && (!event || refreshCapacity || event.updated!==item.updated || event.needsDecision!==item.needsDecision)) {
          try {event=await fetchDetail(item)} catch(error) {fail(error)}
        }
        for(const key of event?.dutyIds || []) if(!related.has(key)) related.set(key,item.id)
      }
      const events=[...remote,...receipts.map(({evidence,messages,...e})=>e)].sort((a,b)=>b.updated-a.updated)
      let model=online?null:previous.model ?? null
      if(online && client.modelRoute) {
        try {model=await client.modelRoute()} catch(error) {if(error.status===401) fail(error)}
      }
      const state={host:config.host,events,model,lastSync:online?now():previous.lastSync,
        dutyOnline,dutySync:dutyOnline?now():previous.dutySync,rule:duty?.rule ?? previous.rule ?? null,
        related:Object.fromEntries(related),reports:duty?.reports ?? previous.reports}
      save(scope,'overview',state)
      return {...state,configured:true,online,settingsUrl:online?new URL('/settings/provider',base).href:null,error:online?'':'调查服务离线，已同步的调查可补读'}
    }
    if(action==='nw-overview') {
      if(!inflight.has(scope)) inflight.set(scope,overview().finally(()=>inflight.delete(scope)))
      return inflight.get(scope)
    }
    if(action==='nw-disable') {
      const current=await readDuty(config)
      if(current.device?.host!==config.host || !current.rule?.enabled || current.rule.ruleId!==data.ruleId)
        throw Error('请刷新并核对当前启用的规则')
      await disableDuty(config,data.ruleId)
      return {ok:true}
    }
    if(action==='nw-workspace-evidence') {
      const linked=db.prepare('SELECT event FROM nw_workspace WHERE session=? AND scope=?').get(data.session,scope)
      // Rebind a pre-existing native session after a credential renewal only when
      // this identity has synced the original event from the same instance.
      const id=linked?.event || home().events.find(e=>workspaceId(e.id)===data.session)?.id
      if(!id) return null
      return handle('nw-event',{id})
    }
    const lookup=action==='nw-record'
    const item=home().events.find(e=>e.id===data.id) ??
      (lookup && home().events.find(e=>e.id==='duty:'+data.id))
    if(lookup && !item) return null
    const result = event => {
      if (!lookup) return event
      if (!event.readOnly && !event.singleHostVerified) return null
      const {id,title,status,updated,online,summary,evidence,linkedId}=event
      return {host:config.host,source:'NightWarden',kind:item.id.startsWith('duty:')?'值班回执':'调查',
        id,title,status,updated,online,summary,evidence,linkedId}
    }
    if(!item) throw Error('请从本主机已同步的调查进入')
    if(action==='nw-workspace-link') {
      const id=workspaceId(item.id)
      db.prepare('INSERT OR REPLACE INTO nw_workspace VALUES(?,?,?)').run(id,scope,item.id)
      return {session:id,host:config.host,event:item.id,title:item.title}
    }
    if(['nw-proposal','nw-handoff'].includes(action)) {
      if(!item.id.startsWith('duty:') || item.id.startsWith('duty:capacity-')) throw Error('请选择业务演练事件')
      const eventId=item.id.slice(5)
      if(action==='nw-proposal') return remoteDecision(config,'propose',{request:{eventId}})
      const {proposalId,choice,requestId,authenticatedActor}=data
      if(typeof authenticatedActor!=='string' || !authenticatedActor.startsWith('dsh-local:')) throw Error('缺少已验证的操作身份')
      return remoteDecision(config,'decide',{request:{eventId,proposalId,choice,requestId},authenticatedActor})
    }
    if(item.id.startsWith('duty:')) {
      if(!lookup && action!=='nw-event') throw Error('请在关联的服务器调查中追问')
      const snapshot=home(), linkedId=snapshot.related?.[item.id]
      const receipt=cached(scope,'event:'+item.id)
      if(lookup && !receipt) return null
      return result({...receipt,online:snapshot.dutyOnline,linkedId:linkedId || null})
    }
    if(action==='nw-event' || lookup) {
      let event
      try {
        event=await fetchDetail(item)
        return result({...event,online:true,nativeUrl:new URL('/investigations/'+encodeURIComponent(item.id),base).href})
      } catch(error) {
        fail(error)
        event=cached(scope,'event:'+item.id)
        if(!event) throw Error('详情尚未同步，请在恢复连接后重试')
        return result({...event,online:false,nativeUrl:null})
      }
    }
    if(action==='nw-question') {
      if(typeof data.message!=='string' || !data.message.trim() || data.message.length>4000) throw Error('请输入有效的调查问题')
      try {
        const row=await client.session(item.id)
        const request=data.clientMessageId
        const message=redact(data.message.trim())
        const digest=createHash('sha256').update(message).digest('hex')
        const prior=typeof request==='string' && db.prepare('SELECT * FROM nw_questions WHERE scope=? AND request=?').get(scope,request)
        if(prior && (prior.event!==item.id || prior.digest!==digest)) throw Error('追问编号与原问题不一致')
        const echoed=row.transcript.some(t=>t.kind==='user_turn' && t.id===request && t.text===message)
        if(prior?.status==='accepted' || echoed) return {ok:true}
        if(prior) throw Error('追问回执待核对，请刷新原调查')
        if(row.running || row.transcript.some(t=>t.state?.phase==='awaiting_human')) throw Error('调查正在运行或等待决定')
        if(typeof request!=='string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(request)) throw Error('追问编号无效')
        db.prepare('INSERT INTO nw_questions VALUES (?,?,?,?,?)').run(scope,request,item.id,digest,'sending')
        try {
          await client.appendMessage(item.id,{message,clientMessageId:request})
        } catch(error) {
          if([400,401,403,404,409,422].includes(error.status))
            db.prepare('DELETE FROM nw_questions WHERE scope=? AND request=?').run(scope,request)
          throw error
        }
        db.prepare("UPDATE nw_questions SET status='accepted' WHERE scope=? AND request=?").run(scope,request)
        return {ok:true}
      } catch(error) {
        fail(error)
        if(error instanceof NightWardenError) throw Error('服务器尚未确认追问，请刷新原调查')
        throw error
      }
    }
    throw Error('未知的值班操作')
  }
}
