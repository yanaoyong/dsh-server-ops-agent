import { execFile } from 'node:child_process'
import { root } from './paths.js'
import path from 'node:path'
import { promisify } from 'node:util'
const run=promisify(execFile)

// Both commands are installed beside the isolated rehearsal database on the enrolled host.
export async function remoteDuty(db, host, operation='read', ruleId=null, payload=null) {
  const target=db.prepare('SELECT h.alias,i.machine FROM workbench_hosts h JOIN identities i ON i.host=h.id WHERE h.id=?').get(host)
  if(!target || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target.alias) || !/^[a-f0-9]{64}$/.test(target.machine))
    throw Error('请核对已登记的主机身份')
  if(!['read','disable','get','propose','decide'].includes(operation)) throw Error('规则操作无效')
  if(operation==='disable' && !/^dsh-rehearsal-[a-f0-9]{32}$/.test(ruleId)) throw Error('规则编号无效')
  const command=operation==='read' ? './read-duty' : operation==='disable' ? './disable-duty '+ruleId : './decision-duty '+operation
  const verify="test \"$(tr -d '\\n' < /etc/machine-id | sha256sum | cut -d' ' -f1)\" = "
  const task=run('/usr/bin/ssh',['-S',path.join(root,'nightwarden-ssh.sock'),'-oControlMaster=no','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oUpdateHostKeys=no',
    '-oClearAllForwardings=yes','-oForwardAgent=no','-oConnectTimeout=6','-T','--',target.alias,
    verify+target.machine+' && cd /var/lib/dsh-nightwarden-rehearsal && '+command],
    {timeout:12000,maxBuffer:8*1024*1024})
  task.child.stdin.on('error',()=>{})
  task.child.stdin.end(payload ? JSON.stringify(payload) : undefined)
  const {stdout}=await task
  return JSON.parse(stdout)
}

const label={firing:'开始调查',resolved:'业务恢复',attempt:'执行记录',escalated:'需要人工决定',auto_recovered:'自动恢复',handoff_approved:'已同意转人工排查',handoff_rejected:'已拒绝转人工排查'}
export function dutyView(raw,host) {
  if(!raw || raw.device?.host!==host || !Array.isArray(raw.events) || !Array.isArray(raw.reports)) throw Error('值班账本与登记主机不符')
  const groups=new Map()
  const cases=new Map((raw.cases || []).map(e=>[e.id,e]))
  for(const row of raw.events) {
    if(!groups.has(row.event_id)) groups.set(row.event_id,[])
    groups.get(row.event_id).push(row)
  }
  const items=[...groups].map(([key,rows])=>{
    const isCapacity=key.startsWith('capacity-'),last=rows.at(-1)
    const policy=cases.get(key)
    const resolved=rows.some(r=>r.kind==='resolved')
    const handed=rows.some(r=>r.kind==='handoff_approved' || r.kind==='handoff_rejected')
    const needsDecision=!resolved && !handed && rows.some(r=>r.kind==='escalated')
    const title=isCapacity?'/srv/appnode 容量调查':raw.device.container+' 业务探测'
    const evidence=rows.map(r=>new Date(r.at*1000).toISOString()+' · '+(label[r.kind] || r.kind)+' · '+r.detail)
    if(policy?.probe_result) evidence.push('动作后业务复查 · '+policy.probe_result)
    const deliveries=raw.deliveries.filter(r=>r.eventId===key && r.channel==='notify')
    for(const d of deliveries) evidence.push('异常通知 · '+(d.sent?'渠道已接收':'待投递')+' · 尝试 '+d.attempts+' 次')
    return {id:'duty:'+key,title,status:resolved?'已恢复':needsDecision?'待人工处置':handed?'业务未确认恢复':'只读调查',needsDecision,updated:last.at,
      summary:last.detail,evidence,messages:[],nativeUrl:null,readOnly:true}
  })
  const byId=new Map(items.map(e=>[e.id,e]))
  const reports=raw.reports.map(r=>{
    const missingSeconds=r.missing.reduce((n,g)=>n+(g.until-g.from),0)
    const refs=[...new Set(r.events.map(e=>'duty:'+e.event_id))]
    return {end:r.until,summary:'自动恢复 '+r.autoRecovered.length+' 项，截止待决定 '+r.awaitingDecision.length+
      ' 项，'+(r.awaitingRecovery ? '持续异常 '+r.awaitingRecovery.length+' 项，':'')+'缺测 '+Math.ceil(missingSeconds/60)+' 分钟',events:refs.map(id=>({id,title:byId.get(id)?.title || id})),
      generated:r.generated,from:r.from,missing:r.missing,capacity:r.capacity}
  })
  return {items,reports,rule:raw.rule,lastSample:raw.lastSample?.observed ?? null}
}
