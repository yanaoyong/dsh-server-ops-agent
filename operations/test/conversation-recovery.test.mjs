import assert from 'node:assert/strict'
import test from 'node:test'
import {registerConversationRecovery} from '../conversation-recovery.js'

function fixture(answer, host='example-host') {
  const tools=new Map(), calls=[]
  const ctx={tools:{register:t=>tools.set(t.name,t)},userQuestions:{ask:async({questions:[q]})=>({answers:[{id:q.id,...answer(q)}]})}}
  const daemon=async(action,data)=>{
    calls.push({action,data})
    if(action==='google-history-preview')return {paths:data.paths,directory:'/private/'+data.requestId+'/files'}
    if(action==='google-history-job')return {status:'done',directory:'/private/'+data.requestId+'/files'}
    return {}
  }
  registerConversationRecovery(ctx,daemon,()=>({host}))
  const run=(name,args,session='fixture')=>tools.get(name).execute(args,{agent:{id:session,session:{header:{cwd:'/fixture'}}},signal:new AbortController().signal})
  return {run,calls}
}
const plan={point:1234567890,paths:['example/notes.md'],source:'local'}
test('only direct human confirmation submits the exact previewed batch',async()=>{
  const {run,calls}=fixture(q=>{
    assert.match(q.question,/example\/notes.md/);assert.match(q.question,/example-host/);assert.match(q.question,/新目录|\/private\//)
    return {selected:['确认恢复']}
  })
  const receipt=await run('recover_workspace_items',plan)
  assert.equal(receipt.status,'done')
  assert.deepEqual(calls.map(c=>c.action),['google-history-preview','google-history-restore','google-history-job'])
  assert.deepEqual(calls[0].data,calls[1].data)
  const retry=await run('recover_workspace_items',plan)
  assert.equal(receipt.requestId,retry.requestId)
  await run('read_workspace_recovery',{requestId:receipt.requestId},'other-session')
  assert.notEqual(calls.at(-1).data.owner,calls[1].data.owner)
})
test('decline, skip, edited selection, mismatched reply and conflicting answers never submit',async()=>{
  for(const answer of [{selected:[]},{selected:['暂不恢复']},{custom:'只恢复另一个文件'},{id:'other',selected:['确认恢复']},
                       {selected:['确认恢复'],custom:'别恢复'},{selected:['确认恢复','暂不恢复']}]){
    const {run,calls}=fixture(()=>answer)
    assert.equal((await run('recover_workspace_items',{...plan,confirmed:true})).status,'not_submitted')
    assert.deepEqual(calls.map(c=>c.action),['google-history-preview'])
  }
})
test('candidate queries only compare and requests from other hosts are rejected',async()=>{
  const args={day:'昨天',fromTime:'10:00',untilTime:'12:00'}
  const {run,calls}=fixture(()=>{throw Error('unexpected question')})
  await run('find_missing_workspace_items',args)
  assert.deepEqual(calls.map(c=>c.action),['google-history-changes'])
  const other=fixture(()=>({selected:['确认恢复']}),'elsewhere')
  await assert.rejects(other.run('recover_workspace_items',plan))
  assert.equal(other.calls.length,0)
})
