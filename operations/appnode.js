import { now, observe, atomic } from './ledger.js'
import { readRemote } from './retained.js'

const labels = {web:'知识库网页 3000',engine:'知识库主引擎 8765',secondary:'知识库观察引擎 8775',
  share:'文件分享 3009',feishu:'OpenClaw 飞书',weixin:'OpenClaw 微信',watch:'GLM 进度守护'}
const expected = {web:200,engine:200,secondary:200,share:404}
const prefix = 'appnode · '
export function enrolledAppnode(db, host) {
  const row = db.prepare(`SELECT h.id,h.alias,i.machine,v.body FROM workbench_hosts h JOIN enrolled e ON e.host=h.id
    JOIN identities i ON i.host=h.id JOIN inventories v ON v.host=h.id WHERE h.id=?`).get(host)
  return row?.id==='example-host' && JSON.parse(row.body).containers.some(c=>c.name==='appnode' && c.observed) ? row : null
}
export async function collectAppnode(db,host,read=readRemote) {
  if (!enrolledAppnode(db,host.id)) return
  const cursor=()=>db.prepare('SELECT last_slot FROM appnode_cursor WHERE host=?').get(host.id)?.last_slot ?? 0
  for (let page=0;page<250;page++) {
    const after=cursor()
    const rows=await read(host,{task:'appnode',machine:host.machine,after})
    for (const [ts,values] of rows) {
      if (!Number.isSafeInteger(ts) || ts%60 || ts<=after || ts>now()+60 || !values) throw Error('业务采样时间无效')
      atomic(db,()=>{
        if (ts<=cursor()) return
        for (const [key,label] of Object.entries(labels)) {
          if (!Object.hasOwn(values,key) && ['feishu','weixin'].includes(key)) continue
          const value=values[key], signal=prefix+label
          let ok=null, note='未取得有效结果'
          if (Object.hasOwn(expected,key) && Number.isInteger(value)) {
            ok=value===expected[key]
            note=(value?'HTTP '+value:'连接失败')+'，预期 '+expected[key]
          } else if (key==='watch' && Number.isInteger(value) && value>=0) {
            ok=value<=600
            note='进度文件距采样 '+value+' 秒'
          } else if (['weixin','feishu'].includes(key) && typeof value==='boolean') {
            ok=value
            note=value?'渠道已连接或运行':'渠道连接或运行异常'
          }
          const last=db.prepare('SELECT ts,value FROM samples WHERE host=? AND signal=? ORDER BY id DESC LIMIT 1').get(host.id,signal)
          const interval=['weixin','feishu'].includes(key)?300:60
          const streak=ok===false ? 1+(last && ts-last.ts<=interval && ts>last.ts ?
            JSON.parse(last.value).consecutive_failures || 0 : 0) : 0
          const alert=key!=='secondary' && streak>=(key==='watch'?1:3)
          observe(db,host.id,signal,ok===null?'unknown':ok?'ok':'bad',
            {note,consecutive_failures:streak,interval,observe_only:key==='secondary'},ts,{openCase:alert})
        }
        db.prepare('INSERT OR REPLACE INTO appnode_cursor VALUES(?,?)').run(host.id,ts)
      })
    }
    if (rows.length<180) return
  }
}

export async function checkDailyOutput(db,host,date) {
  const target=enrolledAppnode(db,host)
  if (!target || typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('请选择主机与任务日期')
  const result=await readRemote(target,{task:'daily-output',machine:target.machine,date})
  return {...result,date}
}

export function businessFeedback(db,{host,component,recovered}) {
  if (!enrolledAppnode(db,host) || !['web','feishu','weixin','share'].includes(component) || typeof recovered!=='boolean') throw Error('请选择业务组件')
  const signal='用户反馈 · '+labels[component]
  if (recovered && !db.prepare('SELECT id FROM cases WHERE host=? AND signal=? AND closed IS NULL').get(host,signal)) throw Error('没有待确认恢复的业务反馈')
  return {id:observe(db,host,signal,recovered?'ok':'bad',{note:recovered?'使用者确认业务已恢复':'使用者反馈业务无法使用'})}
}
