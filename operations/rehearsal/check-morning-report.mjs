import assert from 'node:assert/strict'

const tz=t=>new Date(t*1000).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false})
function sameSet(actual,expected,label){
  assert.equal(new Set(actual).size,actual.length,label+' 重复')
  assert.deepEqual([...actual].sort(),[...new Set(expected)].sort(),label)
}
function only(rows,key,t,label) {
  const result=rows.filter(r=>r[key]===t)
  assert.equal(result.length,1,label+' 应恰好存在一份')
  return result[0]
}

export function checkSnapshot(raw,view,at,{host, day, receipt}) {
  const end=Date.parse(day+'T07:00:00+08:00')/1000, start=end-86400
  assert.equal(raw.device?.host,host)
  assert.equal(view.host,host)
  assert(view.configured && view.online && view.dutyOnline,'需要已成功刷新的调查服务与值班账本')
  const source=only(raw.reports,'until',end,'VPS 日报'), page=only(view.reports,'end',end,'DSH 日报')
  assert.equal(source.timezone,'Asia/Shanghai')
  assert.equal(source.host,host)
  assert.equal(source.from,start)
  assert.equal(page.from,start)
  assert.ok(Number.isSafeInteger(source.generated) && source.generated>=end && source.generated<=at,'实际生成时间超出截止或核验时刻')
  assert.equal(page.generated,source.generated)
  // Rebuild the exact incident set from the independent journal as it stood at the cutoff.
  const prior=raw.events.filter(e=>e.at<end), resolved=new Set(prior.filter(e=>e.kind==='resolved').map(e=>e.event_id))
  const activeInWindow=new Set(prior.filter(e=>e.at>=start || !resolved.has(e.event_id)).map(e=>e.event_id))
  const expected=prior.filter(e=>activeInWindow.has(e.event_id))
  sameSet(source.events.map(e=>e.id),expected.map(e=>e.id),'原始事件时间线')
  assert.deepEqual(source.events,expected,'报告时间线与 VPS 已持久化证据不符')
  assert.ok(source.events.every(e=>e.at<end),'报告含截止后事件')
  const decided=new Set(expected.filter(e=>['handoff_approved','handoff_rejected'].includes(e.kind)).map(e=>e.event_id))
  sameSet(source.autoRecovered,expected.filter(e=>e.kind==='auto_recovered' && e.at>=start).map(e=>e.event_id),'自动恢复')
  sameSet(source.awaitingDecision,expected.filter(e=>e.kind==='escalated' && !decided.has(e.event_id) && !resolved.has(e.event_id)).map(e=>e.event_id),'待决定')
  sameSet(source.awaitingRecovery,[...decided].filter(id=>!resolved.has(id)),'已决定尚未恢复')
  sameSet(page.events.map(e=>e.id),[...activeInWindow].map(id=>'duty:'+id),'DSH 原回执目录')
  assert.ok(activeInWindow.has(receipt),'首份报告没有覆盖已知演练回执')
  assert.deepEqual(page.missing,source.missing)
  let cursor=start
  for (const gap of source.missing) {
    assert(Number.isSafeInteger(gap.from) && Number.isSafeInteger(gap.until) && gap.from>=cursor && gap.until>gap.from && gap.until<=end,'缺测范围重叠或越过报告窗口')
    cursor=gap.until
  }
  assert.deepEqual(page.capacity,source.capacity)
  if(source.capacity.at!=null){
    assert(source.capacity.at>=start && source.capacity.at<end)
    assert.equal(source.capacity.path,'/srv/appnode')
    if(source.capacity.availableChange!=null)assert(source.capacity.previousAt<source.capacity.at && source.capacity.previousAt>=start)
  }
  return {reportId:source.id,host,reportDate:day,timezone:source.timezone,window:{from:tz(start),untilExclusive:tz(end)},
    generated:tz(source.generated),publicationDelaySeconds:source.generated-end,
    receipts:page.events.map(e=>e.id),automatic:source.autoRecovered.length,pendingDecision:source.awaitingDecision.length,
    decidedUnrecovered:source.awaitingRecovery.length,missingSeconds:source.missing.reduce((n,g)=>n+g.until-g.from,0)}
}
