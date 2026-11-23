import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {daemon,dshModels,workspacePath} from './connections.js'
export {daemon,workspacePath} from './connections.js'

export const preset = 'server-ops-chat'

// Import the original per-host transcript once. Stable identity makes reopen and retries idempotent.
export function historySeed(rows, completedTurns=0, existing=new Set()) {
  const seed=[]
  for (const [index,row] of rows.entries()) {
    const turn=completedTurns+index+1, step=1, a=row.answer
    const add=(type,data,surface=false)=>seed.push({seq:seed.length,time:row.ts*1000,type,data,...surface && {surfaceOp:'append'}})
    add('turn/start',{turn})
    // DSH replaces this empty system head with the current preset on the first live turn.
    const initialHead=completedTurns===0 && index===0 && existing.size===0
    if(initialHead) {
      add('step/start',{turn,step})
      add('system/message',{turn,step,message:{id:'ops-system-head',role:'system',source:{kind:'system-prompt'},content:[]}},true)
    }
    if (!existing.has('user-'+row.id)) add('user/message',{id:'user-'+row.id,role:'user',source:{kind:'user'},content:[{type:'text',text:row.question}]},true)
    if (a?.finding) {
      const text=[a.finding,a.unknown && '待核实　'+a.unknown,a.next && '建议　'+a.next,
        row.evidence?.length && '引用证据\n'+row.evidence.map(e=>'#'+e.id+' '+e.signal).join('\n')].filter(Boolean).join('\n\n')
      if(!initialHead) add('step/start',{turn,step})
      add('assistant/message',{turn,step,stream:[],message:{id:'reply-'+row.id,role:'assistant',
        source:{kind:'model',provider:a.provider,model:a.model},content:[{type:'text',text}]}},true)
    }
    if(initialHead || a?.finding) add('step/end',{turn,step})
    add('turn/end',{turn,reason:{kind:'completed'}})
  }
  return seed
}

export async function prepareWorkspace(ctx,host,serverId) {
  // agent-history verifies enrollment before we touch the workspace registry.
  let page=await daemon('agent-history',{host},serverId)
  const cwd=workspacePath(host,serverId)
  await fs.mkdir(cwd,{recursive:true,mode:0o700})
  const ws=await ctx.workspaceRegistry.create(cwd,'运维 · '+host)
  const id='session-ops-history-'+createHash('sha256').update(serverId ?? host).digest('hex').slice(0,24)
  if (!page.length) return {workspaceId:ws.id,cwd}
  const rows=[...page]
  while(page.length===30) {
    page=await daemon('agent-history',{host,before:page.at(-1).id},serverId)
    rows.push(...page)
  }
  rows.reverse()
  const pending=rows.filter(r=>r.status!=='done').map(r=>({question:r.question,status:r.status}))
  {
    let agent=ctx.agents.get(id)
    const stored=agent || await ctx.sessionPersistence.stat(id)
    const {selection,default:defaultModel}=await dshModels(ctx,'agent-models')
    const options={agentOptions:selection || defaultModel,setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,preset)}}
    if(!stored) {
      await ctx.agentPresets.resolve(preset)
      agent=(await ctx.agents.create({...options,sessionId:id,meta:{cwd,agentPreset:preset},seed:historySeed(rows)})).agent
      if(selection) agent.model.select(selection)
      ctx.sessionTitle.rename(agent.session,'历史排查 · '+host)
    } else {
      agent=agent || (await ctx.agents.resume({...options,resumeSessionId:id})).agent
      const existing=new Set(agent.session.deriveMessages().map(m=>m.id))
      const missing=rows.filter(r=>!existing.has('user-'+r.id) || (r.answer?.finding && !existing.has('reply-'+r.id)))
      if(missing.length) {
        const boundary=ctx.agents.turnBoundaryOf(agent.session)
        if(boundary.openTurnStartSeq!==null) return {workspaceId:ws.id,cwd,pendingImport:true,pending}
        agent.session.append(historySeed(missing,boundary.lastTurn,existing).map(e=>
          e.surfaceOp ? [e.type,e.data,{surfaceOp:e.surfaceOp}] : [e.type,e.data]))
      }
    }
    await ctx.sessions.flush(agent.session)
    if(!ws.sessionIds.includes(id)) await ws.attachSession(id)
  }
  return {workspaceId:ws.id,cwd,pendingImport:pending.length>0,pending}
}
