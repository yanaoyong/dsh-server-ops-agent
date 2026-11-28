import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const lifetime = 15 * 60
const rehearsalContainer = 'dsh-nw-rehearsal'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function expectedKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key=>!allowed.includes(key))) throw Error('人工转接请求包含无效字段')
}
function eventKey(value) {
  const id = typeof value === 'string' ? value.replace(/^duty:/,'') : ''
  if (!uuid.test(id)) throw Error('需要原业务事件 ID')
  return id
}
function clock(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('值班时钟无效')
  return value
}

export function createNightwardenDecisions(db, config, {now=()=>Math.floor(Date.now()/1000)}={}) {
  if (config?.host !== 'example-host' || config.container !== rehearsalContainer ||
    !/^[0-9a-f]{64}$/.test(config.containerId ?? '')) throw Error('人工转接仅适用于已登记的独立演练容器')
  db.exec(`
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS nw_handoffs (
      id TEXT PRIMARY KEY,event TEXT NOT NULL,revision INTEGER NOT NULL,host TEXT NOT NULL,container TEXT NOT NULL,
      summary TEXT NOT NULL,signature TEXT NOT NULL,issued INTEGER NOT NULL,expires INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','superseded','expired','approved','rejected')),
      choice TEXT,actor TEXT,request_id TEXT UNIQUE,receipt_id TEXT UNIQUE,decided INTEGER,UNIQUE(event,revision));
    CREATE UNIQUE INDEX IF NOT EXISTS nw_handoff_pending ON nw_handoffs(event) WHERE status='pending';
    CREATE UNIQUE INDEX IF NOT EXISTS nw_handoff_final ON nw_handoffs(event) WHERE receipt_id IS NOT NULL;
  `)
  const latest=db.prepare('SELECT * FROM nw_handoffs WHERE event=? ORDER BY revision DESC LIMIT 1')
  function facts(id) {
    const enrolled=db.prepare('SELECT host,container,probe FROM duty_device WHERE singleton=1').get()
    const pinned=db.prepare('SELECT container_id FROM duty_authority WHERE singleton=1').get()
    if (enrolled?.host!==config.host || enrolled.container!==config.container || enrolled.probe!==config.probeUrl ||
      (pinned && pinned.container_id!==config.containerId)) throw Error('当前账本与登记的演练容器不一致')
    const row=db.prepare(`SELECT e.*,r.active_event, n.created AS escalated
      FROM nw_policy_events e JOIN nw_policy_rules r ON r.id=e.rule_id LEFT JOIN nw_policy_notices n ON n.event_id=e.id
      WHERE e.id=? AND r.host=? AND r.container=?`).get(id,config.host,config.container)
    if (!row) throw Error('演练账本没有该业务事件')
    const records=db.prepare("SELECT kind,at FROM duty_journal WHERE event_id=? AND kind IN ('escalated','resolved') ORDER BY at,rowid").all(id)
    const recovered=row.status==='recovered' || row.observed_recovery!==null || records.some(e=>e.kind==='resolved')
    const eligible=!recovered && row.active_event===id && row.escalated!=null && records.some(e=>e.kind==='escalated') &&
      ['manual_required','failed','unknown'].includes(row.status)
    const signature=createHash('sha256').update(JSON.stringify([id,config.host,config.container,config.containerId,
      config.probeUrl,row.rule_id,row.status,row.reason,row.updated,row.execution_id,row.probe_result,row.escalated,records])).digest('hex')
    const reasons={disabled:'该规则已停用',recurrence:'一小时内复发',interrupted:'执行中断，结果待核对',
      business_probe_bad:'动作后的业务探测失败',business_probe_unknown:'业务复查结果未知',restart_unconfirmed:'动作回执未确认'}
    const summary='将 '+config.host+' 上 '+config.container+' 的未结事件转交人工排查。依据：'+
      (reasons[row.reason] || '业务异常已升级')+'。决定仅记录是否接手，当前业务恢复情况由后续探测核实。'
    return {eligible,recovered,signature,summary}
  }
  function state(row, f, at) {
    let status=row?.status
    if (status==='pending') {
      if (at>=row.expires) status='expired'
      else if (!f.eligible || row.signature!==f.signature) status='superseded'
    }
    return {
      proposal:row ? {id:row.id,eventId:row.event,host:row.host,container:row.container,action:'handoff',summary:row.summary,
        revision:row.revision,issuedAt:row.issued,expiresAt:row.expires,status} : null,
      receipt:row?.receipt_id ? {id:row.receipt_id,proposalId:row.id,eventId:row.event,choice:row.choice,actor:row.actor,decidedAt:row.decided} : null,
      businessRecovered:f.recovered,eligible:!!(f.eligible && !row?.receipt_id)
    }
  }
  return function handle(operation, request, authenticatedActor) {
    if (!['get','propose','decide'].includes(operation)) throw Error('不支持这项值班决定')
    expectedKeys(request,operation==='decide'?['eventId','proposalId','choice','requestId']:['eventId'])
    const id=eventKey(request.eventId)
    if (operation==='decide') {
      if (!uuid.test(request.proposalId) || !uuid.test(request.requestId) || !['approve','reject'].includes(request.choice)) throw Error('提案 ID、请求 ID 或选择无效')
      if (typeof authenticatedActor!=='string' || !/^[\p{L}\p{N}][\p{L}\p{N}._+@:/=-]{0,191}$/u.test(authenticatedActor))
        throw Error('需要受控 DSH 服务端提供已认证的操作者标识')
    }
    db.exec(operation==='get'?'BEGIN':'BEGIN IMMEDIATE')
    try {
      const at=clock(now()),f=facts(id),row=latest.get(id)
      const view=state(row,f,at)
      let result=view
      if (operation==='propose' && !view.receipt && view.proposal?.status!=='pending') {
        if (!f.eligible) throw Error('业务事件当前无需人工转接')
        if (row?.status==='pending') db.prepare('UPDATE nw_handoffs SET status=? WHERE id=?').run(view.proposal.status,row.id)
        db.prepare(`INSERT INTO nw_handoffs(id,event,revision,host,container,summary,signature,issued,expires,status)
          VALUES(?,?,?,?,?,?,?,?,?,'pending')`).run(randomUUID(),id,(row?.revision ?? 0)+1,config.host,config.container,f.summary,f.signature,at,at+lifetime)
        result=state(latest.get(id),f,at)
      }
      if (operation==='decide') {
        if (!row || row.id!==request.proposalId) throw Error('旧提案或目标不匹配，请刷新原事件')
        if (view.receipt) {
          if (row.actor!==authenticatedActor || row.choice!==request.choice || row.request_id!==request.requestId)
            throw Error('该提案已有决定，请查阅原回执')
        } else {
          if (view.proposal.status!=='pending' || !view.eligible) throw Error('提案已过期或业务事件已更新，请刷新原事件')
          const receipt=randomUUID(), status=request.choice==='approve'?'approved':'rejected'
          db.prepare('UPDATE nw_handoffs SET status=?,choice=?,actor=?,request_id=?,receipt_id=?,decided=? WHERE id=?')
            .run(status,request.choice,authenticatedActor,request.requestId,receipt,at,row.id)
          const detail=(status==='approved'?'同意人工接手':'拒绝人工接手')+' · '+authenticatedActor+' · 回执 '+receipt
          db.prepare('INSERT INTO duty_journal(id,event_id,at,kind,detail) VALUES(?,?,?,?,?)')
            .run(receipt,id,at,'handoff_'+status,detail)
          result=state(latest.get(id),f,at)
        }
      }
      db.exec('COMMIT')
      return result
    } catch(error) {db.exec('ROLLBACK');throw error}
  }
}

// The authenticated SSH bridge supplies authenticatedActor separately from the
// browser request. Browser fields never become the identity or an executable action.
async function main() {
  const [operation, filename]=process.argv.slice(2)
  if (!filename || !['get','propose','decide'].includes(operation)) throw Error('用法：nightwarden-decisions.js get|propose|decide /path/to/duty-config.json')
  const config=JSON.parse(fs.readFileSync(filename,'utf8'))
  if (!path.isAbsolute(config.dbPath) || !fs.statSync(config.dbPath).isFile()) throw Error('需要既有演练账本')
  let body=''
  for await(const chunk of process.stdin) {
    body+=chunk
    if (Buffer.byteLength(body)>4096) throw Error('人工决定请求过大')
  }
  const envelope=JSON.parse(body)
  expectedKeys(envelope,['request','authenticatedActor'])
  const db=new DatabaseSync(config.dbPath)
  try {
    console.log(JSON.stringify(createNightwardenDecisions(db,config)(operation,envelope.request,envelope.authenticatedActor)))
  } finally {db.close()}
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1})
}
