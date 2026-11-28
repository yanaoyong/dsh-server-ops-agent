import {setTimeout as delay} from 'node:timers/promises'

export const backupTools = ['read_workspace_backup', 'start_workspace_backup', 'retry_workspace_google',
  'follow_workspace_backup', 'browse_workspace_backup']
export const backupInstructions = '询问 base 工作区备份状态或历史版本时调用 read_workspace_backup，按北京时间分别引用本地和两端的实际数据时间。只在用户明确要求立即备份或重试 Google 时调用对应写工具。百度沿用服务器重试队列。后续只读跟踪，使用返回的 follow 参数调用 follow_workspace_backup。用户要求跟到完成时，在当前会话用最新 follow 续查直至完成、失败或需要人工处理；不要再次提交。不能保证会话关闭后发消息。可用 browse_workspace_backup 查指定版本的目录。'

const phases = new Set(['capturing', 'databases', 'archiving'])
const integer = {type:'integer',minimum:1}
const page = {type:'integer',minimum:0}
const isPoint = value => Number.isSafeInteger(value) && value > 0
const props = (properties, required=[]) => ({type:'object',properties,required,additionalProperties:false})

export function workspaceBackupHost(exec, targetOf) {
  const target = targetOf(exec.agent?.session?.header?.cwd)
  if (target?.host !== 'example-host' || target.serverId || !exec.agent?.id)
    throw Error('请从已登记的 example-host 原生运维会话管理工作区备份')
  return target.host
}

export function registerConversationBackup(ctx, daemon, targetOf) {
  const hostFor = exec => workspaceBackupHost(exec,targetOf)
  function tool(name, description, parameters, execute) {
    ctx.tools.register({name,description,parameters,output:{schema:{type:'object'},
      render:(_,value)=>[{type:'text',text:JSON.stringify(value)}]},execute})
  }

  async function read(host) {
    const [historyResult,googleResult] = await Promise.allSettled([
      daemon('google-history-points',{host}), daemon('google-status',{host})
    ])
    const history = historyResult.value
    const google = googleResult.value
    const points = history?.points
    const latestLocal = points?.[0]?.point ?? null
    const latestBaidu = history?.baidu?.latest ?? points?.find(p=>p.baidu)?.point ?? null
    const latestGoogle = google ? google.started ?? null : points?.find(p=>p.google)?.point ?? null
    const observedAt = Math.floor(Date.now()/1000)
    const cloudPoints = [latestBaidu,latestGoogle]
    const fresh = cloudPoints.some(point=>isPoint(point) && point<=observedAt && observedAt-point<=86400)
    const known = Array.isArray(points) && typeof google?.connected === 'boolean' &&
      cloudPoints.every(point=>point===null || (isPoint(point) && point<=observedAt))
    const summary = {host,observedAt,latestLocal,latestBaidu,latestGoogle,
      offsite24h:fresh?'met':known?'unmet':'unknown',
      capture:history?.capture ?? null,baidu:history?.baidu ?? null,
      google:google ? {connected:google.connected,active:google.active ?? null,
        phase:google.progress?.phase ?? null,point:google.progress?.point ?? null,reason:google.progress?.reason ?? null} : null,
      unavailable:[...(!Array.isArray(points)?['workspace_history']:[]),...(!google?['google_status']:[])]}
    return {summary,points}
  }
  tool('read_workspace_backup','读取工作区本地版本、百度和 Google 验证回执、采集与传输阶段。历史版本按新到旧分页。',
    props({offset:page}), async({offset=0},exec)=>{
      const {summary,points} = await read(hostFor(exec))
      if (!Number.isSafeInteger(offset) || offset<0) throw Error('历史页码无效')
      return {...summary,versions:points?.slice(offset,offset+20) ?? null,
        nextOffset:points?.length>offset+20?offset+20:null}
    })

  tool('start_workspace_backup','按用户明确请求立即采集一次，返回后续跟踪条件。',
    props({}),async(_,exec)=>{
      const host = hostFor(exec)
      const {summary,points} = await read(host)
      if (!points) return {status:'unknown',summary}
      const follow={afterPoint:summary.latestLocal ?? 0,goal:'both'}
      if (summary.capture?.active === true ||
          (summary.capture?.active == null && phases.has(summary.capture?.status))) {
        const progress=summary.capture
        if (progress.status==='sealed' && points.some(p=>p.point===progress.started))
          return {status:'already_in_progress',follow:{point:progress.started,goal:'both'},summary}
        return {status:'already_in_progress',follow,summary}
      }
      const previousFailure=summary.capture?.failedAt ?? summary.capture?.started
      if (summary.capture?.status==='failed' && isPoint(previousFailure)) follow.previousFailure=previousFailure
      try {
        const reply = await daemon('google-history-capture',{host})
        if (reply.active && !reply.submitted) return {status:'already_in_progress',follow,summary}
      }
      catch {return {status:'submission_unknown',follow,summary}}
      return {status:'requested',follow,summary}
    })

  tool('retry_workspace_google','按用户要求唤起已有 Google 队列；用指定版本的回执跟进。',
    props({point:integer}),async({point},exec)=>{
      const host = hostFor(exec)
      const {summary,points} = await read(host)
      if (!points || !summary.google) return {status:'unknown',summary}
      const version = points.find(p=>p.point===(point ?? summary.latestLocal))
      if (!version) return {status:'point_unavailable',summary}
      if (version.google) return {status:'already_verified',point:version.point,summary}
      if (!summary.google.connected) return {status:'connection_required',summary}
      const follow={point:version.point,goal:'google'}
      if (summary.google.active === true) return {status:'already_in_progress',follow,summary}
      try { await daemon('google-retry',{host}) }
      catch {return {status:'submission_unknown',follow,summary}}
      return {status:'requested',follow,summary}
    })

  tool('follow_workspace_backup','只读等待指定版本的验证或新版本封存，返回可跨轮次续查的条件。时间为 Unix 秒。',
    props({point:integer,afterPoint:page,previousFailure:integer,goal:{enum:['local','baidu','google','both']},
      waitSeconds:{type:'integer',minimum:0,maximum:45}},['goal']),
    async({point,afterPoint,previousFailure,goal,waitSeconds=30},exec)=>{
      const host = hostFor(exec)
      if ((point==null)===(afterPoint==null) || (point!=null && !isPoint(point)) ||
          (afterPoint!=null && (!Number.isSafeInteger(afterPoint)||afterPoint<0)) ||
          !['local','baidu','google','both'].includes(goal) ||
          !Number.isInteger(waitSeconds)||waitSeconds<0||waitSeconds>45) throw Error('跟踪条件无效')
      const until=Date.now()+waitSeconds*1000
      for (;;) {
        exec.signal?.throwIfAborted()
        const {summary,points} = await read(host)
        const version = point!=null ? points?.find(p=>p.point===point) : points?.findLast(p=>p.point>afterPoint)
        if (version) point=version.point
        const follow=point!=null ? {point,goal} : {afterPoint,goal}
        if (point==null && previousFailure!=null) follow.previousFailure=previousFailure
        const state={follow,version:version ?? null,summary}
        if (!points) return {status:'unknown',...state}
        if (point!=null && !version) return {status:'point_unavailable',...state}
        if (version && (goal==='local' || (goal==='both'?version.baidu && version.google:version[goal])))
          return {status:'complete',...state}
        if (!version && summary.capture?.status==='failed' && summary.capture.started>afterPoint &&
            (summary.capture.failedAt ?? summary.capture.started)!==previousFailure)
          return {status:'capture_failed',...state}
        if (version && !version.google && ['google','both'].includes(goal)) {
          if (!summary.google) return {status:'unknown',...state}
          if (!summary.google.connected) return {status:'connection_required',...state}
          if (summary.google.phase==='等待重试' && summary.google.active!==true)
            return {status:'google_waiting_retry',...state}
        }
        if (version && !version.baidu && ['baidu','both'].includes(goal) &&
            summary.baidu?.phase==='failed' && summary.baidu.started===point)
          return {status:'baidu_waiting_retry',...state}
        const remaining=until-Date.now()
        if (remaining<=0) return {status:'pending',...state}
        await delay(Math.min(5000,remaining),undefined,{signal:exec.signal})
      }
    })

  tool('browse_workspace_backup','查看一个实际版本内指定目录的文件名与类型。根目录传空字符串。',
    props({point:integer,path:{type:'string'},offset:page},['point','path']),
    ({point,path,offset=0},exec)=>daemon('google-history-browse',{host:hostFor(exec),point,path,offset}))
}
