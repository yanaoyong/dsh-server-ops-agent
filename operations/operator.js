import { atomic, audit, now } from './ledger.js'
import { redact } from './redact.js'
import { sanitizeEvidence } from './model.js'

export function operatorHost(db,id) {
  const host = db.prepare(`SELECT h.id,h.alias FROM workbench_hosts h
    JOIN enrolled e ON e.host=h.id JOIN identities i ON i.host=h.id WHERE h.id=?`).get(id)
  if (!host) throw Error('请选择已登记的值班主机')
  return host
}
export function askOperator(db,{host,question,request}) {
  operatorHost(db,host)
  if (typeof question !== 'string' || !question.trim())
    throw Error('请输入消息')
  if (typeof request !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request))
    throw Error('请求编号无效')
  const text = redact(question.trim())
  return atomic(db,()=>{
    const prior=db.prepare('SELECT o.host,j.question FROM operator_questions o JOIN investigations j ON j.id=o.job WHERE o.job=?').get(request)
    if (prior) {
      if (prior.host!==host || prior.question!==text) throw Error('请求编号已使用')
      return {id:request}
    }
    db.prepare("INSERT INTO investigations(id,incident,ts,question,status) VALUES(?,NULL,?,?,'queued')").run(request,now(),text)
    db.prepare('INSERT INTO operator_questions VALUES(?,?)').run(request,host)
    audit(db,null,'operator','主动只读排查',{host,job:request})
    return {id:request}
  })
}
export function operatorHistory(db,host,before=null) {
  operatorHost(db,host)
  return db.prepare(`SELECT j.id,j.ts,j.question,j.status,j.answer FROM investigations j
    JOIN operator_questions o ON o.job=j.id WHERE o.host=? AND
    (? IS NULL OR j.rowid<(SELECT j2.rowid FROM investigations j2 JOIN operator_questions o2 ON o2.job=j2.id WHERE j2.id=? AND o2.host=?))
    ORDER BY j.rowid DESC LIMIT 30`).all(host,before,before,host)
    .map(row=>{
      const answer=JSON.parse(row.answer)
      const ids=answer?.evidence ?? []
      const evidence=db.prepare('SELECT id,signal,ts,state,value FROM samples WHERE host=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id DESC').all(host,JSON.stringify(ids))
      return {...row,answer,evidence:evidence.map(s=>({...s,value:JSON.parse(s.value)}))}
    })
}

// Resolve the ID against this workspace before reading conclusions or evidence.
export function localRecord(db, host, id) {
  const event = db.prepare('SELECT id,signal,opened,closed FROM cases WHERE host=? AND id=?').get(host,id)
  let jobs
  if (event) {
    jobs = db.prepare(`
      SELECT id,incident,parent_id,status,question,answer,ts FROM investigations
      WHERE incident=? ORDER BY ts DESC,rowid DESC LIMIT 5
    `).all(event.id)
  } else {
    jobs = db.prepare(`
      SELECT j.id,j.incident,j.parent_id,j.status,j.question,j.answer,j.ts FROM investigations j
      LEFT JOIN cases c ON c.id=j.incident
      LEFT JOIN operator_questions o ON o.job=j.id
      WHERE j.id=? AND (c.host=? OR (j.incident IS NULL AND o.host=?))
    `).all(id,host,host)
    if (!jobs.length) return null
  }
  const investigations = jobs.map(({answer,...job})=>{
    const saved=JSON.parse(answer) || {}
    return {...job, finding:saved.finding ?? null, unknown:saved.unknown ?? null,
      next:saved.next ?? null, evidence:saved.evidence ?? [], error:saved.error ?? null}
  })
  const cited=investigations.flatMap(job=>job.evidence)
  const incident=event?.id ?? jobs[0]?.incident ?? null
  const evidence=db.prepare(`
    SELECT id,ts,signal,state,value FROM samples WHERE host=?
      AND (? IS NULL OR incident=?) AND id IN (
        SELECT value FROM json_each(?)
        UNION SELECT id FROM (SELECT id FROM samples WHERE host=? AND incident=? ORDER BY id DESC LIMIT 6)
      ) ORDER BY id DESC
  `).all(host,incident,incident,JSON.stringify(cited),host,event?.id ?? null)
  sanitizeEvidence(evidence,host)
  const visible=new Set(evidence.map(sample=>sample.id))
  for (const job of investigations) job.evidence=job.evidence.filter(id=>visible.has(id))
  return {host,source:'本机巡检账本',kind:event?'事件':'调查',id,event:event ?? null,
    investigations,evidence, ...(event ? {investigationLimit:5} : {})}
}
