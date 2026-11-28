window.__ModuleLoader__.load({
  id: '@local/server-ops-agent',
  factory(require) {
    const R = require('react'),
      h = R.createElement
    const panel = 'server-operations'
    const quickEventLimit = 5
    const recoveredPageSize = 12
    const Connection = R.createContext(null)
    function useApi() {
      const serverId = R.useContext(Connection)
      return R.useCallback((action, data) => request(action, data, serverId), [serverId])
    }
    const fmt = (t) =>
      t
        ? new Date(t * 1000).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false
          })
        : '未知'
    function WorkspaceHistory({host, api}) {
      const [history, setHistory] = R.useState(null)
      const [opened, setOpened] = R.useState(false)
      const [point, setPoint] = R.useState(0)
      const [path, setPath] = R.useState('')
      const [offset, setOffset] = R.useState(0)
      const [listing, setListing] = R.useState(null)
      const [selection, setSelection] = R.useState([])
      const [source, setSource] = R.useState('local')
      const [message, setMessage] = R.useState('')
      const [error, setError] = R.useState('')
      const [busy, setBusy] = R.useState(false)
      const [refresh, reload] = R.useReducer(n=>n+1, 0)
      const retryId = R.useRef(null)
      const version = history?.points.find(row=>row.point===point)
      const query = JSON.stringify([point,path,offset,refresh])
      const visible = listing?.query === query ? listing : null
      R.useEffect(()=>{
        if (!opened) return
        let active=true, timer
        async function update() {
          try {
            const next = await api('google-history-points',{host})
            if (active) {
              setHistory(next)
              setPoint(old=>next.points.some(p=>p.point===old) ? old : next.points[0]?.point || 0)
              setError('')
            }
          } catch(e) { if(active) setError(e.message) }
          if(active) timer=setTimeout(update,10000)
        }
        update()
        return ()=>{active=false;clearTimeout(timer)}
      },[opened,host,api,refresh])
      R.useEffect(()=>{
        if (!opened || !point) return
        let active=true
        api('google-history-browse',{host,point,path,offset}).then(result=>{
          if(active) setListing({...result,query})
        },e=>{if(active) setListing({query,error:e.message})})
        return ()=>{active=false}
      },[opened,host,api,point,path,offset,query])
      function clearSelection() {
        retryId.current=null
        setSelection([])
        setMessage('')
      }
      function enter(next) {
        clearSelection()
        setPath(next)
        setOffset(0)
      }
      async function submit() {
        setBusy(true)
        try {
          retryId.current ||= crypto.randomUUID().replaceAll('-','')
          await api('google-history-restore',{host,point,paths:selection,source,requestId:retryId.current})
          clearSelection()
          setMessage('已提交，可在恢复记录中查看结果。')
          reload()
        } catch(e) {setMessage(e.message)}
        finally {setBusy(false)}
      }
      const button=(label,click,disabled=false)=>h('button',{type:'button',onClick:click,disabled:busy||disabled},label)
      return h('section',{className:'ops-card'},
        h('h3',null,'工作区文件历史'),
        button(opened?'收起文件历史':'浏览历史文件',()=>setOpened(!opened)),
        opened && h(R.Fragment,null,
          error && h('p',{role:'alert'},error),
          !history && !error && h('p',{role:'status'},'正在读取恢复点…'),
          history && button('立即创建工作区恢复点',async()=>{
            setBusy(true)
            try {await api('google-history-capture',{host});setMessage('已请求采集，封存完成后将在列表中显示。');reload()}
            catch(e){setMessage(e.message)} finally {setBusy(false)}
          },['capturing','databases','archiving'].includes(history?.capture?.status)),
          history?.capture?.status==='failed' && h('p',{role:'alert'},'最近一次采集失败，请检查服务器空间和采集任务。'),
          history && !history.points.length && h('p',null,'尚无已封存的工作区版本。'),
          version && h(R.Fragment,null,
            h('label',null,'数据时间（北京时间） ',h('select',{value:point,disabled:busy,onChange:e=>{
              clearSelection();setOffset(0);setSource('local');setPoint(Number(e.target.value))
            }},...history.points.map(p=>h('option',{key:p.point,value:p.point},fmt(p.point))))),
            h('p',null,'本机已封存 · 百度'+(version.baidu?'已验证':'待验证')+' · Google '+(version.google?'已验证':'待验证')),
            h('p',null,'/workspace'+(path?'/'+path:''),' ',path && button('上一级',()=>enter(path.split('/').slice(0,-1).join('/')))),
            !visible && h('p',{role:'status'},'正在读取历史目录；首次打开较早版本可能需要几分钟。'),
            visible?.error && h('p',{role:'alert'},visible.error,' ',button('重试',reload)),
            visible?.missing && h('p',null,'此版本没有这个目录。'),
            visible?.items && !visible.missing && h(R.Fragment,null,
              !visible.items.length && h('p',null,'空目录'),
              h('ul',{'aria-label':'历史目录内容',style:{maxHeight:'24rem',overflowY:'auto',overflowWrap:'anywhere'}},...visible.items.map(item=>{
                const full=path?path+'/'+item.name:item.name
                return h('li',{key:item.name},h('label',null,h('input',{type:'checkbox',
                  disabled:busy || !['reg','dir'].includes(item.kind) || (selection.length>=20&&!selection.includes(full)),
                  checked:selection.includes(full),onChange:()=>{retryId.current=null;setSelection(old=>
                    old.includes(full)?old.filter(p=>p!==full):[...old,full])},
                  'aria-label':'选择 '+item.name}),item.kind==='dir'?null:item.name),
                  item.kind==='dir'?button(item.name+' /',()=>enter(full)):
                    item.kind==='sym'?'（符号链接）':item.kind==='reg'?null:'（特殊文件）')
              })),
              offset>0 && button('上一页',()=>setOffset(offset-100)),
              visible.more && button('下一页',()=>setOffset(offset+100))),
            h('label',null,'读取副本 ',h('select',{value:source,disabled:busy,onChange:e=>{retryId.current=null;setSource(e.target.value)}},
              h('option',{value:'local'},'VPS 本地'),version.google&&h('option',{value:'google'},'Google Drive'),
              version.baidu&&h('option',{value:'baidu'},'百度网盘'))),
            button('恢复所选 '+selection.length+' 项到 VPS 新目录',submit,!visible || !selection.length)),
          message && h('p',{role:'status'},message),
          history?.jobs?.length>0 && h('div',null,h('h4',null,'最近恢复记录'),...history.jobs.map((job,i)=>
            h('p',{key:i},fmt(job.at)+' · '+fmt(job.point)+' 的版本 · '+(job.directory?'已恢复至 '+job.directory:
              job.error || '正在恢复…'))))))
    }

    function GoogleBackup({host, api}) {
      const [state, setState] = R.useState(null)
      const [error, setError] = R.useState('')
      const [notice, setNotice] = R.useState('')
      const [url, setUrl] = R.useState('')
      const [busy, setBusy] = R.useState(false)
      const [point, setPoint] = R.useState('')
      const file = R.useRef(null)
      R.useEffect(() => {
        let active = true, timer
        async function poll() {
          try {
            const next = await api('google-status', {host})
            if (active) {
              setState(next)
              setError('')
              if (!next.authorizing) setUrl('')
            }
          } catch (e) { if (active) { setError(e.message); setState(null) } }
          if (active) timer = setTimeout(poll, 15000)
        }
        poll()
        return () => { active = false; clearTimeout(timer) }
      }, [host, api])
      async function run(action) {
        setBusy(true)
        setNotice('')
        try {
          const data = {host}
          if (action === 'google-connect' && file.current?.files?.length) {
            const input = file.current.files[0]
            if (input.size > 16384) throw Error('请选择 Google 桌面应用客户端 JSON')
            try { data.client = JSON.parse(await input.text()) }
            catch { throw Error('客户端文件不是有效的 JSON') }
          }
          if (action === 'google-restore') data.point = Number(point || state?.versions?.[0])
          const result = await api(action, data)
          if (result.url) setUrl(result.url)
          if (action === 'google-connect' && file.current) file.current.value = ''
          setNotice(result.directory ? '校验通过，样本已恢复到 '+result.directory :
            result.url ? '请在本机浏览器完成 Google 授权。' : '已提交备份任务。')
          setState(await api('google-status',{host}))
        } catch (e) { setNotice(e.message) }
        finally { setBusy(false) }
      }
      const button = (text, action, disabled) => h('button', {type:'button', disabled:busy || disabled,
        onClick:()=>run(action)},text)
      return h('section',{className:'ops-card ops-google-backup'},
        h('h3',null,'Google Drive · base 工作区'),
        h('p',null,error || (state ? state.connected ? '已配置授权' : '待连接 Google 账号' : '读取连接状态中')),
        state?.started && h('p',null,'最近已验证的数据时间 '+fmt(state.started)+' · 恢复核验 '+fmt(state.verified_at)),
        state?.progress?.phase && h('p',null,state.progress.phase+(state.progress.reason?' · '+state.progress.reason:'')),
        h('label',null,'Google 桌面应用客户端 JSON',h('input',{type:'file',accept:'.json',ref:file})),
        button(state?.connected?'重新连接 Google Drive':'连接 Google Drive','google-connect',!state),
        url && h('p',null,h('a',{href:url,target:'_blank',rel:'noreferrer'},'打开 Google 授权页')),
        state?.authError && h('p',{role:'alert'},state.authError),
        state?.connected && button('立即备份或重试','google-retry'),
        Boolean(state?.versions?.length) && h('div',null,
          h('label',null,'Google 恢复点 ', h('select',{value:point || state.versions[0],
            onChange:e=>setPoint(e.target.value)},...state.versions.map(p=>h('option',{key:p,value:p},fmt(p))))),
          button('从 Google 恢复样本到新目录','google-restore')),
        notice && h('p',{role:'status'},notice))
    }

    function scheduleText(schedule) {
      if (!schedule) return null
      if (!schedule.missed) return '原定 ' + fmt(schedule.first)
      return fmt(schedule.first) + ' 至 ' + fmt(schedule.last) +
        '，每日一次，共 ' + (schedule.missed + 1) + ' 次到期合并为本次作业'
    }
    function snapshotAge(seconds) {
      const minutes = Math.floor(seconds / 60)
      return Math.floor(minutes / 1440) + ' 天 ' + Math.floor(minutes / 60) % 24 +
        ' 小时 ' + minutes % 60 + ' 分钟'
    }
    function reportBackup(report,interval) {
      const {body,end}=report
      const sample=body.coverage?.['base 工作区异地备份']?.last ?? body.coverage?.['base 工作区百度网盘备份']?.last
      if (!sample) {
        const point=body.backup
        return {text:point?'最近可恢复版本生成于 '+fmt(point.ts):'尚未确认可恢复版本',point}
      }
      if (!['ok','bad'].includes(sample.state) || sample.ts>=end || end-sample.ts>2*interval+5)
        return {text:'截止时 base 工作区备份缺测'}
      const value=typeof sample.value==='string'?JSON.parse(sample.value):sample.value
      const ts=value?.point, verified=value?.verified_at
      if (ts==null && sample.state==='bad') return {text:'截止时尚无已验证的 base 工作区恢复点'}
      if (!Number.isFinite(ts) || !Number.isFinite(verified) || ts<=0 || ts>verified || verified>sample.ts)
        return {text:'截止时 base 工作区恢复点待核实'}
      return {text:'base 工作区恢复点 · '+fmt(ts)+(end-ts>86400?' · 已超过 24 小时目标':''),
        point:{ts,verified_at:verified}}
    }
    function diskSummary(disk) {
      if (!disk.last) return '窗口内无有效容量样本'
      const gib = bytes => (bytes / 2 ** 30).toLocaleString('zh-CN', { maximumFractionDigits: 3 })
      const parts = ['可用 ' + gib(disk.last.available) + ' GiB', disk.samples + ' 次有效采样']
      if (disk.trend) {
        const rate = disk.trend.bytesPerDay
        parts.push(rate === 0 ? '首尾可用空间持平' :
          '可用空间日均' + (rate > 0 ? '减少 ' : '增加 ') + gib(Math.abs(rate)) + ' GiB')
        if (disk.trend.estimatedDays !== null) parts.push('按此速度约 ' + disk.trend.estimatedDays + ' 天用尽')
      } else {
        parts.push('有效采样跨度不足 1 小时')
      }
      return parts.join(' · ')
    }
    const status = {
      ok: '正常',
      bad: '异常',
      unknown: '缺测或待核实',
      pending: '待决定',
      rejected: '已拒绝',
      approved: '已批准',
      expired: '已失效',
      verified: '验证通过',
      failed: '失败',
      running: '进行中',
      done: '已完成',
      retry: '等待重试',
      queued: '已排队',
      interrupted: '中断',
      restored: '已恢复',
      reindexed: '索引已核验',
      executing: '执行中'
    }
    const panelStyles = `
.ops-panel {
  --canvas:#f5f7f8; --paper:#fff; --ink:#172d36; --muted:#526972; --line:#d5dfe1;
  --accent:#006d69; --wash:#e3f2ee; --warn:#83450e; --amber:#fff0d9;
  color-scheme:light dark; container-type:inline-size; overflow:auto; height:100%; width:100%;
  color:var(--ink); background:var(--canvas); font:14px/1.55 "Inter","PingFang SC",system-ui,sans-serif;
  overflow-wrap:anywhere; text-align:start;
}
.ops-panel *, .ops-panel {box-sizing:border-box}
.ops-inner {max-width:1120px; margin:0 auto; padding:22px clamp(14px,4cqw,36px) 48px}
.ops-connect {margin:0 0 16px;padding:14px;border:1px solid var(--line);border-radius:12px}
.ops-connect label {display:grid;gap:4px;min-width:0}
.ops-connect-fields {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:10px;margin:0 0 12px}
.ops-connect-row {display:flex;align-items:end;flex-wrap:wrap;gap:10px}
.ops-header {display:flex; align-items:center; gap:12px; margin:0 0 16px}
.ops-panel h1,.ops-panel h2,.ops-panel h3,.ops-panel p {margin:0}
.ops-panel h1 {font-size:23px; font-weight:720; letter-spacing:-.06em}
.ops-panel h2 {font-size:19px; font-weight:700; letter-spacing:-.035em; margin:24px 0 10px}
.ops-panel h3 {font-size:16px; font-weight:680; margin:18px 0 8px}
.ops-panel p {margin:8px 0}
.ops-mark {width:33px;height:33px;display:grid;align-content:center;justify-items:center;gap:3px;background:#0d5557;border-radius:9px}
.ops-mark i {height:4px;width:18px;border:1px solid #a3e7ce;border-radius:1px;background:linear-gradient(to right,transparent 70%,#a3e7ce 70%)}
.ops-panel nav {display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line);margin:0 0 18px}
.ops-panel button,.ops-panel select,.ops-panel input {
  font:inherit; font-size:13px; color:var(--ink); background:var(--paper); border:1px solid var(--line);
  border-radius:7px; min-height:34px; padding:6px 10px; max-width:100%;
}
.ops-panel button {cursor:pointer; font-weight:580; white-space:normal}
.ops-panel button:hover:enabled,.ops-panel summary:hover {background-color:var(--wash)}
.ops-panel button:disabled,.ops-panel select:disabled {opacity:.55;cursor:default}
.ops-panel :is(button,summary,select,input,textarea,a):focus-visible {outline:3px solid #329b97;outline-offset:2px}
.ops-panel nav button {position:relative;min-width:58px;background:transparent;border:0;color:var(--muted);padding:8px 13px;border-radius:5px 5px 0 0}
.ops-panel nav button[aria-current] {color:var(--accent);font-weight:750}
.ops-panel nav button[aria-current]::after {content:"";position:absolute;bottom:-1px;left:10px;right:10px;height:3px;background:var(--accent);border-radius:3px}
.ops-panel .ops-primary {background:var(--accent);color:var(--paper);border-color:var(--accent)}
.ops-panel .ops-primary:hover:enabled {background:var(--accent);filter:brightness(.93)}
.ops-panel [role=status]:empty {display:none}
.ops-panel [role=status]:not(:empty),.ops-panel [role=alert] {padding:10px 12px;border-radius:7px;color:var(--accent);background:var(--wash)}
.ops-panel [role=alert] {color:var(--warn);background:var(--amber)}
.ops-hero {position:relative;isolation:isolate;overflow:hidden;border-radius:14px;background:#113f44;color:#fff;padding:19px 22px 21px}
.ops-hero::after {content:"";position:absolute;z-index:-1;inset:0;opacity:.36;background-image:linear-gradient(90deg,transparent,#113f4400),linear-gradient(#78d1b633 1px,transparent 1px),linear-gradient(90deg,#78d1b633 1px,transparent 1px);background-size:auto,19px 19px,19px 19px;mask-image:linear-gradient(105deg,transparent 20%,black)}
.ops-hero-top,.ops-section-head,.ops-link-label {display:flex;align-items:center;justify-content:space-between;gap:10px}
.ops-hero-top h2 {font-size:16px;color:#e6f8f4;margin:0}
.ops-hero-top>span {font-size:11px;color:#bddee0}
.ops-panel time,.ops-metrics strong,.ops-incident small,.ops-link-card small {font-variant-numeric:tabular-nums}
.ops-metrics {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:18px}
.ops-metrics>div {display:grid;gap:2px;padding-left:clamp(8px,3cqw,28px);border-left:1px solid #6b9897}
.ops-metrics>div:first-child {padding-left:0;border:0}
.ops-metrics strong {font:520 clamp(30px,7cqw,48px)/1.05 "Inter",system-ui,sans-serif;letter-spacing:-.06em}
.ops-metrics span {font-size:12px;color:#d0e7e7}
.ops-shortcuts {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0 22px}
.ops-panel .ops-link-card {display:grid;gap:4px;padding:12px 14px;text-align:left;border-radius:11px}
.ops-link-label {font-size:12px;color:var(--muted)}
.ops-link-label i,.ops-incident i {font:normal 18px/1 system-ui;color:var(--accent)}
.ops-link-card strong {font-size:19px;letter-spacing:-.035em}
.ops-link-card small,.ops-incident small {font-size:12px;font-weight:450;color:var(--muted)}
.ops-section-head {margin-bottom:9px;flex-wrap:wrap}
.ops-section-head h2 {margin:0}
.ops-filter {display:flex;gap:2px;padding:2px;background:var(--paper);border:1px solid var(--line);border-radius:8px}
.ops-filter button {min-height:26px;padding:2px 8px;font-size:12px;border:0;color:var(--muted)}
.ops-filter button[aria-pressed=true] {background:var(--wash);color:var(--accent)}
.ops-card,.ops-list,.ops-group,.ops-empty,.ops-controls {background:var(--paper);border:1px solid var(--line);border-radius:10px}
.ops-card,.ops-group,.ops-empty {padding:13px 15px;margin:8px 0}
.ops-card h3:first-child,.ops-group h3:first-child {margin-top:0}
.ops-list {overflow:hidden}
.ops-panel .ops-incident {display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;border-radius:0;padding:11px 14px}
.ops-incident+.ops-incident,.ops-list details+details {border-top:1px solid var(--line)}
.ops-incident-body {flex:1;min-width:0;display:grid;gap:2px}
.ops-incident-body strong {font-size:14px}
.ops-badge {display:inline-flex;align-items:center;gap:5px;white-space:nowrap;vertical-align:middle;font-size:11px;font-weight:650;padding:2px 7px;border-radius:5px}
.ops-badge::before {content:"";width:5px;height:5px;border-radius:50%;background:currentColor}
.ops-badge.ok {background:var(--wash);color:var(--accent)}
.ops-badge.warn {background:var(--amber);color:var(--warn)}
.ops-section-head.ops-backup-head {margin:18px 0 10px}
.ops-backup-head label {margin:0}
.ops-card>.ops-controls {padding:10px 0 0;border-width:1px 0 0;border-radius:0;margin-bottom:0}
.ops-report-title,.ops-report-stats {display:flex;align-items:center;gap:12px}
.ops-report-title {justify-content:space-between}
.ops-report-title h3 {margin:0}
.ops-report-title time {margin-right:auto;font-size:12px;color:var(--muted)}
.ops-incident-hero {padding:14px clamp(14px,3cqw,22px);border-bottom:1px solid var(--line);background:var(--paper)}
.ops-incident-hero h2 {font-size:clamp(16px,3cqw,22px);line-height:1.4;margin:4px 0}
.ops-event-meta {display:flex;align-items:center;flex-wrap:wrap;gap:5px 12px;color:var(--muted);font-size:12px}
.ops-event-meta .ops-host {margin:0;font-size:13px;color:var(--ink)}
.ops-incident-hero .ops-event-note {margin:4px 0;color:var(--muted);font-size:13px}
.ops-event-tools {display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;margin-bottom:10px}
.ops-panel .ops-switch {display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0;color:var(--muted);font-size:13px}
.ops-panel .ops-switch select {margin:0;width:auto;max-width:100%}
.ops-event-list>.brief-section+.brief-section {margin-top:14px}
.ops-panel .ops-event-search {display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin:0 0 12px}
.ops-event-search input {flex:1;max-width:380px;min-width:min(100%,14em)}
.ops-panel .ops-event-more {margin-top:8px}
.ops-incident-card {border:1px solid var(--line);border-radius:14px;background:var(--paper);overflow:hidden}
.event-conversation {--chat-inset:clamp(14px,4cqw,32px)}
.event-conversation-heading {display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px var(--chat-inset)}
.event-conversation-heading h3 {font-size:14px;margin:0}
.event-transcript {padding:3px var(--chat-inset) 18px;min-height:90px;max-height:clamp(200px,52vh,560px);overflow:auto;scrollbar-gutter:stable}
.event-transcript:focus-visible,.event-answer:focus-visible {outline:2px solid var(--accent);outline-offset:-2px}
.event-turns {list-style:none;display:grid;gap:22px;max-width:760px;margin:0 auto;padding:0}
.event-turn {display:grid;gap:12px;min-width:0}
.event-user-message {justify-self:end;min-width:0;max-width:min(88%,65ch);background:var(--wash);padding:9px 12px;border-radius:12px 12px 3px 12px}
.event-message-meta {display:flex;align-items:baseline;gap:6px 9px;flex-wrap:wrap;color:var(--muted);font-size:12px}
.event-message-meta b {color:var(--ink);font-size:12px}
.ops-panel .event-user-message p,.ops-panel .event-answer p {margin:5px 0;white-space:pre-wrap}
.ops-panel .event-user-message p:last-child,.ops-panel .event-answer p:last-child {margin-bottom:0}
.event-answer {justify-self:start;min-width:0;max-width:min(100%,72ch)}
.event-answer-actions {display:flex;flex-wrap:wrap;align-items:center;gap:3px 7px;margin-top:6px}
.ops-panel .event-chat-link {background:transparent;border:0;color:var(--accent);min-height:28px;padding:3px 5px;font-size:12px}
.ops-panel .event-parent-link {display:block;text-align:start;padding-inline:0;max-width:100%;min-height:24px}
.event-answer-actions .event-cite {min-height:28px;padding:3px 6px;font-size:12px}
.ops-panel .event-empty {margin:8px auto;color:var(--muted);max-width:760px}
.ops-followup {border-top:1px solid var(--line);padding:10px var(--chat-inset) 12px;background:var(--paper)}
.event-compose {max-width:760px;margin:0 auto}
.ops-panel .event-compose label {margin:0 0 5px;font-weight:650}
.ops-followup-row {display:flex;gap:8px;align-items:flex-end}
.ops-panel .ops-followup-row textarea {min-width:0;flex:1;font:inherit;font-size:14px;color:var(--ink);background:var(--canvas);border:1px solid var(--line);border-radius:8px;padding:8px 10px;resize:vertical;min-height:52px;max-height:154px}
.ops-followup-row button {flex:none}
.ops-followup .ops-followup-note {margin:8px 0 0;font-size:13px}
.event-quote {display:flex;align-items:center;gap:7px;border-inline-start:2px solid var(--accent);padding:2px 6px 2px 8px;margin:1px 0 7px;background:var(--canvas);color:var(--muted);font-size:12px}
.event-quote span {flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@container (max-width:460px) {
  .event-user-message {max-width:95%}
  .event-transcript {scrollbar-gutter:auto}
}

.ops-decision {margin:12px 0 17px;border-left:4px solid var(--accent)}
.ops-decision.awaiting {border-left-color:#b17727}
.ops-decision h3 {margin:0 0 5px}
.ops-decision p {margin:4px 0}
.ops-panel details.ops-disclosure {background:var(--paper);border:1px solid var(--line);border-radius:9px;margin:7px 0;padding:0 14px}
.ops-disclosure>summary {font-weight:650;padding:11px 0}
.ops-disclosure[open] {padding-bottom:10px!important}
.ops-disclosure .ops-count {color:var(--muted);font-weight:450;margin-left:7px}
.ops-disclosure details {padding-inline:4px}
.ops-host {margin:0 8px;font-family:ui-monospace,monospace}
@container (min-width:800px) {
  .ops-reports {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}
  .ops-reports .ops-card {margin:0}
}
.ops-report-stats {padding:8px 0;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;margin-bottom:10px}
.ops-report-stats strong {color:var(--ink);font-size:18px}
.ops-panel label {display:block;margin:8px 0;font-size:13px;color:var(--muted)}
.ops-panel label select {margin:0 0 0 6px}
.ops-controls {display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px;margin:8px 0}
.ops-controls input {min-width:0;flex:1}
.ops-group>button {margin:2px 5px 3px 0}
.ops-group-actions {display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.ops-group-actions button {margin:0}
.ops-group-fields {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin:10px 0}
.ops-group-fields label {min-width:0;margin:0}
.ops-panel .ops-production-backup .ops-fact {grid-template-columns:145px minmax(0,1fr)}
.ops-panel .ops-fact {display:grid;grid-template-columns:minmax(64px,24%) minmax(0,1fr);gap:9px;font-size:13px}
.ops-fact strong {color:var(--muted);font-weight:550}
.ops-panel details {background:var(--paper);border-bottom:1px solid var(--line);padding:0 10px}
.ops-list details {border:0}
.ops-panel summary {padding:9px 0;cursor:pointer;font-size:13px}
.ops-panel pre {overflow:auto;max-height:320px;white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;border-radius:6px;background:var(--canvas);font:12px/1.5 "IBM Plex Mono",ui-monospace,monospace;color:var(--muted)}
.ops-panel small,.ops-empty {color:var(--muted)}
@container (max-width:390px) {
  .ops-inner {padding-inline:12px}.ops-hero {padding:15px}.ops-hero-top {flex-wrap:wrap}
  .ops-shortcuts {gap:6px}.ops-panel .ops-link-card {padding:10px}.ops-link-card strong {font-size:16px}
  .ops-panel label select {display:block;width:100%;margin:3px 0 0}.ops-panel nav {gap:0}
  .ops-group-fields {grid-template-columns:minmax(0,1fr)}
}
@media (prefers-color-scheme:dark) {
  .ops-panel {--canvas:#172327;--paper:#1e2e33;--ink:#e6efef;--muted:#adc1c7;--line:#3d5157;--accent:#8cddd0;--wash:#284641;--warn:#f5c484;--amber:#483a26}
  .ops-panel .ops-primary {color:#10312f}
}
.ops-studio {--night:#16383c;--mint:#9fe8ca;display:grid;gap:20px}
.ops-panel .ops-session-row {display:block;width:100%;text-align:start;padding:12px 14px;margin-top:8px}
.chat-log {max-height:min(52vh,620px);overflow:auto;overscroll-behavior:contain;margin:16px 0;padding:0 8px 3px 0;scrollbar-gutter:stable}
.chat-turn {display:grid;gap:14px;padding:12px 0}
.chat-user {justify-self:end;max-width:90%;background:var(--wash);border-radius:14px 14px 3px 14px;padding:10px 15px}
.chat-user small,.chat-agent small {font-size:12px;color:var(--muted)}
.chat-turn p {white-space:pre-wrap;overflow-wrap:anywhere}
.ops-studio .chat-user p {margin:2px 0}
.chat-agent {max-width:94%;line-height:1.7}
.chat-agent .studio-meta strong {color:var(--accent)}
.ops-studio .studio-banner {position:relative;overflow:hidden;isolation:isolate;border-radius:16px;background:var(--night);color:#f5fffb;padding:24px clamp(18px,3cqw,32px);display:flex;align-items:center;gap:16px}
.studio-banner::after {content:"";position:absolute;inset:0 0 0 50%;z-index:-1;background-image:radial-gradient(circle,#75c6af65 1px,transparent 1.3px);background-size:10px 10px;mask-image:linear-gradient(90deg,transparent,#000)}
.ops-studio .studio-banner h2 {color:inherit;margin:0;font-size:clamp(24px,3.3cqw,34px);line-height:1.25;letter-spacing:-.04em}
.ops-studio .studio-banner p {margin:4px 0 0;color:#c5ded6;font-size:13px}
.studio-glyph {display:grid;place-items:center;width:46px;height:46px;flex:none;border:1px solid #699789;border-radius:13px;color:var(--mint);background:#244b49;font:600 22px/1 ui-monospace,monospace}
.studio-work {display:grid;grid-template-columns:minmax(0,1fr) 280px;align-items:start;gap:16px}
.studio-card,.studio-record {min-width:0;padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--paper)}
.ops-studio h3 {margin:0;font-size:17px;line-height:1.45;letter-spacing:-.02em}
.studio-card-head,.studio-actions,.studio-meta,.studio-record-foot,.studio-history-head {display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.studio-card-head,.studio-actions,.studio-record-foot,.studio-history-head {justify-content:space-between}
.ops-studio label {margin:0}
.ops-studio .studio-host {display:flex;align-items:center;gap:6px;color:var(--muted)}
.ops-studio .studio-host select {width:auto;margin:0;font:600 13px ui-monospace,monospace}
.ops-studio textarea {width:100%;display:block;margin:14px 0 8px;padding:12px 14px;resize:vertical;min-height:78px;border:1px solid var(--line);border-radius:9px;background:var(--canvas);color:var(--ink);font:inherit}
.ops-studio textarea::placeholder {color:var(--muted)}
.ops-studio textarea:focus-visible {outline:2px solid var(--accent);outline-offset:2px}
.studio-prompts {display:flex;gap:6px;flex-wrap:wrap}
.ops-studio .studio-prompts button {min-height:32px;border-radius:20px;background:var(--paper);color:var(--muted);padding:4px 10px;font-size:12px}
.studio-actions {margin-top:12px}
.studio-actions small,.studio-meta,.studio-record-foot,.studio-history-head small {font:12px/1.5 ui-monospace,"PingFang SC",monospace;color:var(--muted)}
.ops-studio .ops-primary {border-radius:8px;padding:8px 16px}
.ops-studio .ops-primary:disabled {background:var(--canvas);color:var(--muted);border-color:var(--line);opacity:1}
.studio-model {border-top:3px solid var(--accent);padding-top:17px}
.studio-model-name {display:block;font:600 18px/1.4 ui-monospace,monospace;margin:12px 0 4px;overflow-wrap:anywhere}
.ops-studio .studio-model-meta {margin:0 0 14px;color:var(--muted);font-size:12px}
.ops-studio details {border:0;padding:0;background:transparent}
.ops-studio summary {border-radius:5px;color:var(--accent);font-weight:600}
.ops-studio .studio-settings {border-top:1px solid var(--line)}
.studio-settings label {display:grid;gap:4px}
.ops-studio .studio-settings select {display:block;margin:0;width:100%}
.studio-settings-body {display:grid;gap:10px}
.studio-settings-body p {font-size:12px;color:var(--muted)}
.studio-settings-buttons {display:flex;gap:6px;flex-wrap:wrap}
.ops-studio .studio-draft {color:var(--warn);background:var(--amber);margin:0;padding:6px 8px;border-radius:5px}
.studio-history {display:grid;gap:10px}
.ops-studio .studio-history-head h2 {font-size:20px;margin:0}
.studio-meta {gap:8px}
.ops-studio .studio-record h3 {font-size:16px;margin:10px 0;color:var(--ink)}
.ops-studio .studio-finding {white-space:pre-line;background:var(--wash);border-left:3px solid var(--accent);padding:12px 15px;border-radius:0 8px 8px 0;margin:12px 0;line-height:1.7}
.studio-finding strong {display:block;color:var(--accent);font-size:12px;margin-bottom:3px}
.studio-notes {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:12px 0;font-size:13px}
.studio-notes strong {color:var(--muted);font-size:12px}
.ops-studio .studio-notes p {margin:3px 0;white-space:pre-line}
.studio-record-foot {justify-content:flex-start;border-top:1px solid var(--line);padding-top:6px}
.studio-record-foot>small {margin-left:auto}
.studio-record-foot:has(details[open]) {align-items:start}
.studio-record-foot details[open] {flex:1 1 100%}
.ops-studio .studio-evidence details {border-top:1px solid var(--line)}
.studio-evidence summary {overflow-wrap:anywhere}
.ops-studio .studio-older {padding:4px 16px;background:var(--paper);border:1px solid var(--line);border-radius:10px}
.studio-older article {border-width:1px 0 0;border-radius:0;padding-inline:0}
@container (max-width:800px) {
  .studio-work {grid-template-columns:minmax(0,1fr)}
  .studio-model {padding:14px 18px;border-top:1px solid var(--line);border-left:3px solid var(--accent)}
  .studio-model-name {margin:4px 0;font-size:16px}
}
@container (max-width:520px) {
  .ops-studio {gap:14px}.studio-work {gap:10px}.studio-card,.studio-record {padding:14px}
  .studio-notes {grid-template-columns:1fr;gap:6px}
  .ops-studio :is(button,select,summary),.ops-studio .studio-prompts button {min-height:44px}
  .studio-record-foot>small {margin-left:0}
}

.brief-page {max-width:780px;margin:clamp(16px,4cqw,44px) auto 0;color:var(--ink)}
.server-chart {margin-bottom:22px;padding:clamp(14px,3cqw,24px);background:var(--paper);border:1px solid var(--line);border-radius:14px;font-variant-numeric:tabular-nums}
.server-chart header,.server-line {display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.server-chart header {border-bottom:1px solid var(--line);padding-bottom:14px;flex-wrap:wrap}
.ops-panel .server-chart h2 {margin:0;font-size:22px}
.server-chart header b {font:600 13px ui-monospace,monospace;color:var(--muted)}
.server-stamp {text-align:end;display:grid;font-size:13px}
.server-resources {display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:clamp(14px,4cqw,36px)}
.server-chart h3 {margin:16px 0 9px}.server-meter {margin:10px 0 13px}
.server-line,.server-load b {font-size:13px}.server-line strong {font-size:16px}
.server-track {position:relative;height:8px;margin:4px 0;border-radius:8px;background:var(--line)}
.server-track i {display:block;height:100%;background:var(--accent);border-radius:inherit}
.server-track.high i {background:#c67927}.server-track em {position:absolute;top:-2px;bottom:-2px;border-left:2px solid var(--ink)}
.server-load {margin-top:12px;display:grid}.server-load strong {font-size:23px}
.capacity-trend {border-top:1px solid var(--line);padding:14px 0 18px}
.trend-heading {display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.server-chart .trend-heading h3 {margin:0;font-size:16px}
.trend-tabs {display:flex;flex-wrap:wrap;gap:2px;background:var(--canvas);padding:3px;border-radius:7px}
.trend-options {display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ops-panel .server-chart .trend-tabs button {margin:0;text-decoration:none;padding:4px 9px;color:var(--muted)}
.ops-panel .server-chart .trend-tabs button[aria-pressed=true] {background:var(--paper);color:var(--accent);box-shadow:0 1px 3px #0002}
.trend-meta,.trend-foot {font-size:12px;color:var(--muted)}
.trend-plot {display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 9px;margin-top:16px}
.trend-axis {display:flex;flex-direction:column;justify-content:space-between;text-align:right;color:var(--muted);font-size:11px;line-height:1}
.trend-canvas {display:block;width:100%;height:110px;overflow:visible}
.trend-times {grid-column:2;display:flex;justify-content:space-between;color:var(--muted);font-size:11px}
.trend-legend {display:inline-block;width:16px;vertical-align:middle;margin:0 4px 0 8px;border-top:2px dashed #ae650a}
.trend-gap {display:inline-block;width:12px;height:10px;vertical-align:middle;background:var(--line);margin:0 4px 0 8px}
.server-health {border-top:1px solid var(--line)}.server-health table {width:100%;border-collapse:collapse;font-size:13px}
.server-health th,.server-health td {text-align:center;padding:6px 2px;border-bottom:1px solid var(--line)}
.server-health th:first-child {text-align:start}.server-health thead {color:var(--muted)}
.server-cell {display:inline-block;font-size:12px;font-weight:600;padding:3px 7px;border-radius:5px;background:var(--canvas);color:var(--muted)}
.server-cell.ok {background:var(--wash);color:var(--accent)}.server-cell.notice,.server-cell.bad,.server-alert {background:var(--amber);color:var(--warn)}
.monitor-switch {padding-top:14px;border-top:1px solid var(--line)}.monitor-switch .trend-heading {margin-bottom:8px}.monitor-switch .trend-tabs {flex-wrap:wrap}
.monitor-switch .server-health {border-top:0}.rule-description {display:block;font-weight:400;color:var(--muted)}
.server-none {color:var(--muted)}.server-alert {padding:6px 10px;border-radius:6px}
.ops-panel .server-chart button {min-height:24px;padding:0 4px;margin-left:5px;color:var(--accent);font-size:12px;border:0;background:none;text-decoration:underline}
@container (max-width:520px) {
  .server-resources {grid-template-columns:minmax(0,1fr);gap:0}.server-health {margin-top:12px}
  .server-cell {padding:2px 4px}.server-stamp {text-align:start}
}
.brief-lead {padding:0 0 24px;border-bottom:1px solid var(--line)}
.ops-panel .brief-kicker,.brief-edition {display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ops-panel .brief-kicker {margin:0 0 14px;color:var(--accent);font-size:13px;font-weight:650}
.brief-kicker span,.brief-edition span,.brief-incident small,.ops-panel .brief-footnote {color:var(--muted);font-size:12px;font-weight:450}
.ops-panel .brief-lead h2 {font:650 clamp(22px,3.5cqw,34px)/1.38 "Songti SC","STSong",serif;letter-spacing:.01em;margin:0;text-wrap:balance}
.ops-panel .brief-deck {margin:10px 0;color:var(--muted);line-height:1.75}
.brief-lead>button {margin-top:8px}
.brief-plan {background:var(--amber);border-radius:8px;margin:12px 0;padding:13px 16px}
.brief-section {padding:18px 0 5px}
.ops-panel .brief-section h3 {font-size:14px;line-height:1.6;margin:0 0 8px}
.ops-panel .brief-incident {display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;text-align:start;background:var(--paper);border-radius:0;border-width:0 0 1px;padding:12px 15px;font-size:14px}
.brief-incident span:first-child {min-width:0}
.brief-incident small {display:block;margin-top:3px}
.brief-incident span:last-child:not(:first-child) {color:var(--accent);font-size:18px}
.brief-shelf {display:flex;gap:8px 20px;flex-wrap:wrap;margin-top:18px}
.ops-panel .brief-shelf button,.ops-panel .brief-link {border:0;color:var(--accent);padding:6px 0;background:transparent}
.ops-panel .brief-footnote {margin:2px 0 18px}
.ops-panel .brief-fold {margin:12px 0;border:1px solid var(--line);border-radius:8px;padding:0 14px;background:transparent}
.ops-panel .brief-fold>summary {font-weight:600;color:var(--muted);padding:11px 0}
.ops-panel .brief-fold[open] {background:var(--paper);padding-bottom:12px}
.brief-edition {margin-bottom:20px;border-bottom:1px solid var(--line);padding-bottom:10px}
.brief-section .ops-fact {grid-template-columns:70px minmax(0,1fr)}
@container (max-width:520px) {
  .brief-lead {padding-bottom:14px}.brief-section {padding-top:14px}
  .ops-panel .brief-shelf button,.ops-panel .brief-incident,.ops-panel .brief-fold>summary {min-height:44px}
}

.daily-page {max-width:none;margin:0}
.daily-front,.daily-highlights>.brief-section,.daily-page>.night-warden-duty {background:var(--paper);border:1px solid var(--line);border-radius:12px}
.daily-front {border-top:3px solid var(--accent);padding:clamp(16px,2.5cqw,28px)}
.daily-front .brief-edition {margin:0 0 16px;padding:0 0 12px;align-items:center}
.daily-front .brief-edition strong {font-size:17px}
.daily-front .brief-edition label,.daily-front .brief-deck {margin:0}
.daily-front .brief-lead {border:0;padding:0}
.daily-front .brief-kicker {justify-content:flex-start;margin-bottom:6px}
.daily-front .brief-lead h2 {font-family:inherit;font-size:clamp(22px,3cqw,32px);font-weight:680;margin-bottom:8px;letter-spacing:-.035em}
.daily-highlights {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px;margin:12px 0}
.daily-highlights>.brief-section,.daily-page>.night-warden-duty {min-width:0;padding:16px 20px}
.daily-highlights .ops-fact {grid-template-columns:max-content minmax(0,1fr)}
.ops-panel .daily-highlights .brief-incident {border-top:1px solid var(--line);border-bottom:0;padding:9px 0;min-height:40px}
.daily-page>.night-warden-duty {margin-top:18px}
.duty-report-head,.duty-connection,.duty-event {display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap}
.duty-report-head {justify-content:space-between}
.ops-panel .duty-report-head h3 {font-size:17px;margin:0}
.duty-connection {font-size:12px;color:var(--muted);padding-bottom:10px}
.duty-connection b {font-weight:600}
.duty-connection b::before {content:"";display:inline-block;width:7px;height:7px;background:var(--warn);border-radius:50%;margin-right:6px}
.duty-connection b.online::before {background:var(--accent)}
.duty-report {border-top:1px solid var(--line);padding:14px 0 6px;font-variant-numeric:tabular-nums}
.ops-panel .duty-report h4 {margin:0 0 4px;font-size:15px}
.duty-report .duty-times,.duty-report small {color:var(--muted);font-size:12px}
.duty-times {display:flex;gap:2px 20px;flex-wrap:wrap}
.duty-report .duty-summary {font-weight:600;margin:12px 0 6px}
.duty-report>details {font-size:13px;color:var(--muted)}
.duty-body {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:12px;margin-top:12px;align-items:start}
.duty-capacity,.duty-events {min-width:0;border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.duty-capacity {background:var(--canvas)}
.duty-capacity>strong,.duty-events>strong {display:block;font-size:13px}
.duty-capacity .duty-reading {font-size:20px;font-weight:650;margin:4px 0}
.duty-reading span {font-size:13px;font-weight:450;color:var(--muted)}
.duty-capacity small,.duty-event small {display:block}
.duty-event {flex-wrap:nowrap;justify-content:space-between;border-top:1px solid var(--line);padding:6px 0}
.duty-event:first-of-type {margin-top:6px}
.duty-event button {flex:none}
.night-warden-duty .duty-event-list>.brief-incident {display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 14px}
.night-warden-duty .duty-event-list>.brief-incident>strong {min-width:0;overflow-wrap:anywhere}
.night-warden-duty .duty-event-list>.brief-incident>p {margin:0;min-width:0;overflow-wrap:anywhere}
.night-warden-duty .duty-event-list>.brief-incident>button {grid-column:2;grid-row:1 / span 2;min-width:96px;min-height:36px;margin:0;padding:6px 10px;white-space:nowrap}
.nw-followup textarea {display:block;width:100%;min-height:72px;padding:8px 10px;resize:vertical;font:inherit;color:var(--ink);background:var(--canvas);border:1px solid var(--line);border-radius:7px}
.nw-followup-actions {display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.nw-followup-actions a {display:inline-flex;align-items:center;min-height:34px;padding:6px 10px;border:1px solid var(--line);border-radius:7px;color:var(--accent);font-size:13px}
.duty-archive {border-top:1px solid var(--line);margin-top:10px;padding:10px 0}
@container (max-width:520px) {
  .daily-front .brief-edition label {width:100%}
  .daily-highlights>.brief-section,.daily-page>.night-warden-duty {padding:14px}
}

`
    const block = { className: 'ops-card' }
    const row = { className: 'ops-controls' }
    const btn = (s, f, disabled = false, kind = '') =>
      h('button', { type: 'button', onClick: f, disabled, className: kind }, s)
    const fact = (label, value) =>
      h('p', { className: 'ops-fact' }, h('strong', null, label), h('span', null, value))
    const json = (v) =>
      h('pre', null, typeof v === 'string' ? v : JSON.stringify(v, null, 2))
    const badge = (text, tone) => h('span', { className: 'ops-badge ' + tone }, text)
    const shortTime = (ts) => new Date(ts * 1000).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false
    })
    const trendLabels = {pct:'已用比例',bytes:'可用空间',memory:'可用内存',load:'15 分钟平均负载'}
    function ResourceTrend({host, resource, title, interval, threshold, hours, setHours, system=false}) {
      const api = useApi()
      const [history, setHistory] = R.useState(null)
      const [error, setError] = R.useState('')
      const [metric, setMetric] = R.useState(system?'memory':'pct')
      R.useEffect(()=>{
        let live=true, timer
        async function refresh() {
          try {
            const data=await api('overview',{section:'resource-history',host,resource})
            if (!Array.isArray(data.rows) || !Number.isFinite(data.end)) throw Error('后台尚未提供资源历史')
            if (live) {setHistory(data);setError('')}
          } catch (e) {if (live) setError(e.message)}
          if (live) timer=setTimeout(refresh,interval*1000)
        }
        refresh()
        return ()=>{live=false;clearTimeout(timer)}
      },[host,resource,interval])
      const pct=metric==='pct' || metric==='memory'
      const label=trendLabels[metric]
      const heading=h('div',{className:'trend-heading'},h('h3',null,title+' · 最近 '+hours+' 小时'),
        h('div',{className:'trend-options'},
          h('div',{className:'trend-tabs',role:'group','aria-label':'指标'},(system?['memory','load']:['pct','bytes']).map(key=>
            h('button',{key,type:'button','aria-pressed':metric===key,onClick:()=>setMetric(key)},trendLabels[key]))),
          h('select',{'aria-label':'历史时段',value:hours,onChange:e=>setHours(Number(e.target.value))},
            [1,6,24].map(n=>h('option',{key:n,value:n},n+' 小时')))))
      const section=(...children)=>h('section',{className:'capacity-trend','aria-label':title+'趋势'},
        heading,error && h('p',{role:'alert'},'趋势更新失败 · '+error),...children)
      if (!history) return section(!error && h('p',null,'正在读取资源历史…'))
      const end=history.end, start=end-hours*3600
      const rows=history.rows.filter(row=>row.ts>=start && row.ts<=end)
      const runs=[]
      let run=null, low=Infinity, high=-Infinity, count=0
      for (const row of rows) {
        const value=row[metric]
        if (!['ok','bad'].includes(row.state) || !Number.isFinite(value) || value<0 || (pct && value>100)) {
          run=null
          continue
        }
        if (!run || row.ts-run.at(-1).ts>2*interval+5) {run=[];runs.push(run)}
        const v=metric==='bytes' ? value/2**30 : value
        run.push({ts:row.ts,v})
        low=Math.min(low,v);high=Math.max(high,v);count++
      }
      const windowText=fmt(start)+' 至 '+fmt(end)+'（北京时间）'
      if (!count) return section(h('small',null,windowText),h('p',null,'这段时间没有有效的'+label+'采样。'))
      const mark=metric==='pct' && Number.isFinite(threshold) && threshold>=0 && threshold<=100 ? threshold : null
      const span=Math.max(high-low,pct?2:0.02)
      const floor=Math.max(0,Math.min(low,mark ?? low)-span/2)
      const ceil=pct ? Math.min(100,Math.max(high,mark ?? high)+span/2) : high+span/2
      const x=t=>100*(t-start)/(end-start)
      const y=v=>100*(ceil-v)/(ceil-floor)
      const format=v=>pct ? Number(v.toFixed(1))+'%' : metric==='bytes' ? v.toFixed(3)+' GiB' : v.toFixed(2)
      const time=t=>shortTime(t).slice(0,5)
      const strokes={vectorEffect:'non-scaling-stroke',fill:'none'}
      const gaps=[]
      let previous=start
      for (const [i,points] of runs.entries()) {
        const first=points[0].ts
        if (first>previous && (i>0 || first-start>interval || rows[0].ts<first))
          gaps.push([previous,first])
        previous=points.at(-1).ts
      }
      if (end-previous>interval || rows.at(-1).ts>previous) gaps.push([previous,end])
      const summary=low===high ? '有效采样均为 '+format(low) : '有效采样范围 '+format(low)+' – '+format(high)
      return section(h('p',{className:'trend-meta'},windowText),
        h('div',{className:'trend-plot'},
          h('div',{className:'trend-axis'},h('span',null,format(ceil)),h('span',null,format((ceil+floor)/2)),h('span',null,format(floor))),
          h('svg',{className:'trend-canvas',viewBox:'0 0 100 100',preserveAspectRatio:'none',role:'img','aria-label':label+'趋势，'+summary},
            gaps.map(([a,b])=>h('rect',{key:a,x:x(a),y:0,width:x(b)-x(a),height:100,fill:'var(--line)',opacity:0.65})),
            [0,50,100].map(v=>h('line',{key:v,x1:0,x2:100,y1:v,y2:v,stroke:'var(--line)',...strokes})),
            runs.map((points,i)=>h('path',{key:i,d:points.map((p,j)=>(j?'L':'M')+x(p.ts).toFixed(3)+' '+y(p.v).toFixed(3)).join(' ')+(points.length===1?' l0 0.01':''),
              stroke:'var(--accent)',strokeWidth:3,strokeLinecap:'round',...strokes})),
            mark!==null && h('line',{x1:0,x2:100,y1:y(mark),y2:y(mark),stroke:'#ae650a',strokeDasharray:'5 5',strokeWidth:1.4,...strokes})),
          h('div',{className:'trend-times'},[0,1,2,3,4].map(i=>h('span',{key:i},time(start+i*(end-start)/4))))),
        h('p',{className:'trend-foot'},summary+' · '+count+' 次',
          mark!==null && h(R.Fragment,null,h('i',{className:'trend-legend'}),'当前告警线 '+mark+'%'),
          gaps.length>0 && h(R.Fragment,null,h('i',{className:'trend-gap'}),'缺测时段')))
    }
    // Rules agreed for example-host. Match each check to its ledger signal so an absent
    // or stale sample stays visible even when the collector is unavailable.
    const entryRules = (name,port,expected) => [
      ['容器 '+name,'检查运行、健康状态及短时间内的重启次数'],
      ['业务探针 '+name,'从服务器探测容器内的 '+port+' 端口'],
      [(expected===401?'鉴权入口 ':'代理入口 ')+name+':'+port,'经代理访问，预期 HTTP '+expected]
    ]
    const dutyScopes = {
      'appnode': [
        ...entryRules('appnode',3080,200), ['appnode.service','检查系统服务是否运行'],
        ['挂载容量 /srv/appnode','达到挂载容量告警线时开事件'],
        ...['知识库网页 3000','知识库主引擎 8765','知识库观察引擎 8775','文件分享 3009',
          'OpenClaw 微信','OpenClaw 飞书','GLM 进度守护'].map(name=>{
          let rule='预期 HTTP 200，连续三次有效异常开事件'
          if (name.includes('8775')) rule='预期 HTTP 200，异常仅记录'
          if (name.includes('3009')) rule='无效链接预期 HTTP 404，连续三次有效异常开事件'
          if (name.startsWith('OpenClaw')) rule='每五分钟检查渠道状态，连续三次有效异常开事件'
          if (name.startsWith('GLM')) rule='进度文件超过十分钟未更新时开事件'
          return ['appnode · '+name,rule]
        })],
      'base': [
        ['base · 开发任务回执','查看最近完成的一轮。退出失败、任务报错或超过 30 分钟没有回执时开事件'],
        ['base · Codex 远程连接','向运行中的 Codex 查询远程连接状态。连接过程和读不到状态单列待核实'],
        ['base · 开发调度器','检查 task-scheduler 是否运行'],['base · 开发工作区挂载','核对 /workspace 来源、读写挂载和可访问性'],
        ['base · Codex 模型代理','检查 model-router 进程状态'],['base · 远程 SSH 服务','检查容器内 sshd 进程'],
        ['base · AoE 会话管理','检查 AoE 会话管理进程'],...entryRules('base',3080,200),
        ['base 工作区百度网盘备份','百度副本须通过抽样恢复，并展示最近验证的数据时间'],
        ['base 工作区异地备份','查看百度与 Google 最近验证的数据时间，检查最近 24 小时是否有合格异地版本']],
      'example-gateway': [['容器 example-gateway','检查反向代理容器的运行状态'],
        ['代理请求错误率','达到最少请求数且 5xx 比例触线时开事件'],
        ['代理入口 base:3080','base 代理入口预期 HTTP 200'],
        ['代理入口 appnode:3080','appnode 代理入口预期 HTTP 200'],
        ['鉴权入口 example-site:8080','静态站点未登录时预期 HTTP 401']],
      'example-site': entryRules('example-site',8080,401),
      '宿主机': [['SSH 连接','核验主机身份与 SSH 连通性'],['主机容量','检查根卷、inode、可用内存和 15 分钟负载'],
        ['挂载容量 /data','达到挂载容量告警线时开事件'],['失败单元','记录 systemd 报告的失败服务'],
        ['内核 OOM','检查最近五分钟的内存耗尽记录'],['可疑 IP','检查同一来源五分钟内的 SSH 认证失败次数'],
        ['fail2ban 既有策略','读取 sshd 的封禁状态']]
    }
    const certPrefix='TLS 证书 '
    function monitoredScopes(samples) {
      const inventory=samples.find(s=>s.signal==='证书域名清单')
      const names=inventory?.state==='ok' && Array.isArray(inventory.value?.domains) ?
        inventory.value.domains : samples.filter(s=>s.signal.startsWith(certPrefix)).map(s=>s.signal.slice(certPrefix.length)).sort()
      return {...dutyScopes,'域名证书':[['证书域名清单','读取 Caddy 登记的域名'],...names.map(domain=>
        [certPrefix+domain,'核验实际提供的证书。到期前 14 天进日报，剩 3 天或已过期开事件'])]}
    }
    function certificateText(v,at) {
      if (!Number.isFinite(v.expires)) return v.reason || '未取得证书到期时间'
      const hours=Math.floor((v.expires-at)/3600)
      const left=hours<0?'已到期':hours<24?'剩余 '+hours+' 小时':'剩余 '+Math.floor(hours/24)+' 天 '+hours%24+' 小时'
      return left+' · '+fmt(v.expires)+' 到期'
    }
    function reportCertificates(report) {
      const coverage=report.body.coverage||{}
      const inventory=coverage['证书域名清单']?.last
      if (!inventory) return null
      const value=row=>typeof row.value==='string'?JSON.parse(row.value):row.value
      const domains=value(inventory)?.domains || []
      const rows=[]
      if (inventory.state!=='ok' || report.end-inventory.ts>245)
        rows.push('域名清单在截止时缺测')
      for (const domain of domains) {
        const s=coverage[certPrefix+domain]?.last
        if (!s || s.state==='unknown' || report.end-s.ts>245) {rows.push(domain+' · 截止时缺测');continue}
        const v=value(s)
        if (s.state==='bad' || v.expires-report.end<=14*86400)
          rows.push(domain+' · '+certificateText(v,report.end))
      }
      return rows.length>0 && h('section',{className:'brief-section'},h('h3',null,'证书到期提醒'),
        rows.map(line=>h('p',{key:line},line)))
    }
    function sshOnline(ssh,clock,interval) {
      return ssh?.state==='ok' && Number.isFinite(ssh.ts) && clock-ssh.ts<=2*interval+5
    }
    function checkResult(sample,clock,interval,disconnected,sshOffline) {
      if (!sample) return {tone:'unknown',text:'尚无采样'}
      const window=sample.value?.interval ? sample.value.interval+200 : 2*interval+5
      if (disconnected || (sshOffline && sample.signal!=='SSH 连接') || !Number.isFinite(sample.ts) || clock-sample.ts>window)
        return {tone:'unknown',text:'等待新采样'}
      const v=sample.value||{}
      if (sample.state==='unknown') return {tone:'unknown',text:v.reason || v.note || status.unknown}
      let text=status[sample.state]||'待核实'
      if (sample.signal.startsWith(certPrefix)) return {
        tone:v.level==='report'?'notice':sample.state,text:certificateText(v,sample.ts)}
      if (sample.signal==='证书域名清单' && sample.state==='ok') text=v.count+' 个域名'
      else if (sample.signal==='base 工作区异地备份') text='百度 '+(v.sources?.baidu?fmt(v.sources.baidu):'待核实')+
        ' · Google '+(v.sources?.google?fmt(v.sources.google):'待核实')
      else if (sample.signal==='base 工作区百度网盘备份') text=v.point ?
        (sample.state==='ok'?'恢复点达标':'恢复点待核实或已逾期') : '尚无已验证恢复点'
      else if (v.expected_http && v.code) text='HTTP '+v.code+'，预期 '+v.expected_http
      else if (Number.isInteger(v.status)) text='HTTP '+v.status
      else if (Array.isArray(v.status) && v.status.length) text+=' · '+v.status[0]
      else if (Number.isFinite(v.used_pct)) text='已用 '+v.used_pct+'% · 告警线 '+v.threshold_pct+'%'
      else if (v.units?.length) text=v.units.join('、')
      else if (v.note) text=v.note
      else if (sample.signal==='代理请求错误率' && v.access_records===0) text='窗口内无请求'
      return {tone:sample.state,text}
    }
    function CheckRows({rules,samples,clock,interval,disconnected,sshOffline,openEvent,showRule}) {
      return h('table',null,h('thead',null,h('tr',null,...['检查项','最近结果','采样时间'].map(x=>h('th',{key:x},x)))),
        h('tbody',null,rules.map(([signal,rule])=>{
          const s=samples.find(row=>row.signal===signal)
          const result=checkResult(s,clock,interval,disconnected,sshOffline)
          return h('tr',{key:signal},h('th',{scope:'row'},signal,showRule && h('small',{className:'rule-description'},rule)),
            h('td',null,h('span',{className:'server-cell '+result.tone},result.text),
              result.tone==='bad' && s?.incident && btn('查看事件',()=>openEvent(s.incident))),
            h('td',null,s?fmt(s.ts):'—'))
        })))
    }
    function BusinessMonitor(props) {
      const [scope,select]=R.useState('appnode')
      const [hours,setHours]=R.useState(24)
      const disks={
        appnode:{resource:'/srv/appnode',title:'/srv/appnode'},
        base:{resource:'/data',title:'base 工作区所在卷 /data'},
        '宿主机':{resource:'/',title:'宿主机根分区 /'}
      }
      const disk=disks[scope]
      const mount=disk && props.samples.find(s=>s.signal==='挂载容量 '+disk.resource)
      const trend=disk && h(ResourceTrend,{key:disk.resource,...disk,hours,setHours,host:props.host,interval:props.interval,threshold:mount?.value?.threshold_pct})
      if (props.host!=='example-host') return h(R.Fragment,null,h(AppnodeStatus,props),mount && trend)
      const scopes=monitoredScopes(props.samples)
      return h('section',{className:'monitor-switch','aria-label':'业务监测'},
        h('div',{className:'trend-heading'},h('h3',null,'业务监测'),
          h('div',{className:'trend-tabs',role:'group','aria-label':'监测对象'},Object.keys(scopes).map(name=>
            h('button',{key:name,type:'button','aria-pressed':scope===name,onClick:()=>select(name)},name)))),
        scope==='appnode' ? h(AppnodeStatus,props) : h('div',{className:'server-health'},h(CheckRows,{...props,rules:scopes[scope]})),
        trend)
    }
    function ProductionRules(props) {
      const sshOffline=!sshOnline(props.samples.find(s=>s.signal==='SSH 连接'),props.clock,props.interval)
      return h('section',{className:'server-chart','aria-label':'生产值班规则'},
        h('h2',null,'值班规则'),h('p',null,props.host+' · 生产巡检与告警'),
        Object.entries(monitoredScopes(props.samples)).map(([scope,rules])=>{
          let abnormal=0,unknown=0,notices=0
          for (const [signal] of rules) {
            const s=props.samples.find(row=>row.signal===signal)
            const {tone}=checkResult(s,props.clock,props.interval,props.disconnected,sshOffline)
            if (tone==='bad') abnormal++
            if (tone==='unknown') unknown++
            if (tone==='notice') notices++
          }
          return h('details',{className:'brief-fold server-health',key:scope},
            h('summary',null,scope+' · '+rules.length+' 项检查　'+(abnormal?abnormal+' 项异常　':'')+
              (unknown?unknown+' 项待核实　':'')+(notices?notices+' 项日报提醒':'')+(!abnormal && !unknown && !notices?'采样正常':'')),
            h(CheckRows,{...props,rules,sshOffline,showRule:true}))
        }),
        h('h3',null,'人工执行与待接入事项'),
        h('p',null,'逐次确认 · 生产维护每次单独约时间，重启、清理或覆盖恢复前确认范围。'),
        h('p',null,'按需核对 · daily-output 按任务日期核对产出。知识库真实问答和文件实际下载由业务方验证。'),
        h('p',null,'调查服务 · 在下方 NightWarden 查看连接状态和最近同步时间。'),
        h('p',null,'待核实 · 指标库停更和关键挂载脱落需另行核实。'))
    }
    function AppnodeStatus({samples,host,clock,disconnected,sshOffline,openEvent}) {
      const api = useApi()
      const business=samples.filter(s=>s.signal.startsWith('appnode · '))
      const feedback=samples.filter(s=>s.signal.startsWith('用户反馈 · '))
      const [date,setDate]=R.useState(()=>new Date((clock+8*3600)*1000).toISOString().slice(0,10))
      const [message,setMessage]=R.useState('')
      const [pending,setPending]=R.useState('')
      const request=R.useRef(0)
      if (!business.length) return host==='example-host' ? h('p',null,'appnode 暂无业务采样。') : null
      async function run(kind,action) {
        const id=++request.current
        setPending(kind)
        setMessage('')
        try {
          const note=await action()
          if (id===request.current) setMessage(note)
        } catch (e) {
          if (id===request.current) setMessage(e.message)
        } finally {
          if (id===request.current) setPending('')
        }
      }
      function changeDate(value) {
        if (pending==='output') {
          request.current++
          setPending('')
        }
        setDate(value)
        setMessage('')
      }
      const keys={'知识库网页 3000':'web','OpenClaw 飞书':'feishu','OpenClaw 微信':'weixin','文件分享 3009':'share'}
      return h('section',{className:'server-health'},h('h3',null,'appnode 业务监测'),
        h('table',null,h('thead',null,h('tr',null,...['业务','最近结果','采样时间'].map(x=>h('th',{key:x},x)))),
          h('tbody',null,business.map(s=>{
            const label=s.signal.slice('appnode · '.length)
            const fresh=!disconnected && !sshOffline && clock-s.ts<=(s.value.interval||60)+200
            const tone=fresh?s.state:'unknown'
            const prior=feedback.find(f=>f.signal==='用户反馈 · '+label)
            const recovered=prior?.state==='bad'
            return h('tr',{key:s.signal},h('th',{scope:'row'},label),
              h('td',null,h('span',{className:'server-cell '+tone},fresh?s.value.note:'等待新采样'),
                fresh && tone==='bad' && h('small',null,s.value.observe_only?' · 仅观察':' · 连续 '+s.value.consecutive_failures+' 次'),
                fresh && s.state==='bad' && s.incident && btn('查看事件',()=>openEvent(s.incident)),
                keys[label] && btn(recovered?'确认业务恢复':'反馈业务不可用',()=>run('feedback',async()=>{
                  const r=await api('agent-ask',{topic:'appnode-feedback',host,component:keys[label],recovered})
                  openEvent(r.id);return recovered?'已记录恢复':'已建立业务反馈事件'
                }),Boolean(pending))),
              h('td',null,fmt(s.ts)))
          }))),
        h('label',null,'daily-output 任务日期 ',h('input',{type:'date',value:date,onChange:e=>changeDate(e.target.value)})),
        btn('核对本次产出',()=>run('output',async()=>{
          const r=await api('overview',{section:'daily-output-check',host,date})
          return r.date+' · 产出目录'+(r.output?'已生成':'未找到')+' · 备份目录'+(r.backup?'已生成':'未找到')+
            ' · '+(r.tracking===null?'分支同步情况未知':r.tracking?'与本地跟踪分支一致':'与本地跟踪分支有差异')
        }),Boolean(pending)||!date),message && h('p',{role:'status'},message))
    }
    function ServerStatus({host, samples, clock, interval, disconnected, openEvent, service}) {
      const [hours,setHours]=R.useState(24)
      const sample = name => samples.find(s => s.signal === name)
      const ssh = sample(service ? '本机 SSH 服务' : 'SSH 连接')
      const fresh = s => s && Number.isFinite(s.ts) && clock - s.ts <= 2 * interval + 5 && !disconnected
      const connected = !disconnected && (service ? fresh(sample('本机采集')) && sample('本机采集').state === 'ok' : sshOnline(ssh,clock,interval))
      const current = s => connected && fresh(s) && s.state !== 'unknown'
      const capacity = sample('主机容量')
      const mounts = samples.filter(s => s.signal.startsWith('挂载容量 '))
        .sort((a,b) => (b.value?.used_pct ?? -1) - (a.value?.used_pct ?? -1))
      const connection = service ? (disconnected ? '同步中断' : '已从服务器同步') :
        !fresh(ssh) ? (ssh ? '采样已中断' : '暂无采样') :
        ssh.state === 'ok' ? 'SSH 已连通' : ssh.state === 'bad' ? 'SSH 连接异常' : 'SSH 待核实'
      const percent = n => Number.isFinite(n) && n >= 0 && n <= 100
      function meter(label, s, value, note, threshold) {
        const valid = current(s) && percent(value)
        const warning = valid && percent(threshold) && value >= threshold
        return h('div',{className:'server-meter',key:label},
          h('div',{className:'server-line'},h('b',null,label),h('strong',null,valid ? value+'%' : '缺测')),
          h('div',{className:'server-track'+(warning?' high':''),'aria-hidden':true},
            valid && h('i',{style:{width:value+'%'}}),
            valid && percent(threshold) && h('em',{style:{left:threshold+'%'}})),
          valid && h('small',null,note,percent(threshold) ? ' · 告警线 '+threshold+'%' : '',
            warning && s.incident && h('button',{type:'button',onClick:()=>openEvent(s.incident)},'查看容量告警')))
      }
      const services = new Map()
      const patterns = [/^容器 (.+)$/, /^业务探针 (.+)$/, /^(?:代理|鉴权)入口 (.+):[0-9]+$/]
      for (const s of samples) {
        patterns.forEach((pattern, column) => {
          const match = pattern.exec(s.signal)
          if (!match) return
          if (!services.has(match[1])) services.set(match[1],[[],[],[]])
          services.get(match[1])[column].push(s)
        })
      }
      const memory = capacity?.value?.available_memory_pct
      const load = capacity?.value?.load15
      const failure = sample('失败单元')
      const space = s => Number.isFinite(s?.value?.available_bytes) ?
        '可用 '+(s.value.available_bytes / 2**30).toLocaleString('zh-CN',{maximumFractionDigits:2})+' GiB' : '可用空间未知'
      return h('section',{className:'server-chart','aria-label':host+' 服务器现状'},
        h('header',null,h('div',null,h('h2',null,'服务器现状'),h('b',null,host)),
          h('div',{className:'server-stamp'},h('strong',null,connection),
            service ? h(R.Fragment,null,
              h('small',null,'服务版本 '+service.version+' · 最近同步 '+fmt(service.lastSyncedAt)),
              h('small',null,'最近服务器采样 · '+fmt(service.latestSample)),
              h('small',null,'DSH 最近 SSH 连接 · '+fmt(service.lastConnectedAt)),
              ssh && h('small',null,'本机 SSH 服务 · '+status[ssh.state]+' · '+fmt(ssh.ts))) :
              h('small',null,ssh ? '最近 SSH 采样 · '+fmt(ssh.ts) : '尚无 SSH 记录'))),
        h('div',{className:'server-resources'},
          h('section',null,h('h3',null,'磁盘已用'),
            ...mounts.map(s=>meter(s.signal.slice(5),s,s.value?.used_pct,space(s),s.value?.threshold_pct)),
            meter('/（根分区）',capacity,capacity?.value?.root_used_pct,space(capacity))),
          h('section',null,h('h3',null,'宿主机内存与负载'),
            meter('可用内存',capacity,memory,'可供应用使用'),
            h('div',{className:'server-load'},h('b',null,'15 分钟平均负载'),
              h('strong',null,current(capacity) && Number.isFinite(load) ? load.toFixed(2) : '缺测'),
              current(capacity) && Number.isFinite(capacity.value?.logical_cpu) &&
                h('small',null,capacity.value.logical_cpu+' 个逻辑 CPU')))),
        h(ResourceTrend,{host,interval,hours,setHours,resource:'/',title:'宿主机内存与负载',system:true}),
        (!service || services.size>0) && h(BusinessMonitor,{samples,host,clock,interval,disconnected,sshOffline:!connected,openEvent}),
        (!service || services.size>0 || current(failure) && failure.state==='bad') &&
        h('section',{className:'server-health'},h('h3',null,'全机服务健康'),
          services.size ? h(R.Fragment,null,h('table',{'aria-label':'各服务最近一次巡检结果'},
            h('thead',null,h('tr',null,...['服务','容器','业务探针','代理入口'].map(v=>h('th',{key:v,scope:'col'},v)))),
            h('tbody',null,...Array.from(services).sort(([a],[b])=>a.localeCompare(b)).map(([name,cols])=>
              h('tr',{key:name},h('th',{scope:'row'},name),...cols.map((rows,i)=>h('td',{key:i},
                rows.length ? rows.map(s=>{
                  const tone = current(s) && ['ok','bad'].includes(s.state) ? s.state : 'unknown'
                  return h('span',{key:s.signal,className:'server-cell '+tone,title:s.signal+' · '+fmt(s.ts)},
                    tone==='ok' ? '✓ 正常' : tone==='bad' ? '！异常' : '◇ 缺测')
                }) : h('span',{className:'server-none'},'—'))))))),
            h('small',null,'代理入口由服务器本机探测。横线表示没有对应巡检记录。')) : h('p',null,'暂无服务巡检记录。'),
          current(failure) && failure.state==='bad' && h('p',{className:'server-alert'},
            '系统服务异常 · '+(failure.value?.units?.join('、') || '检测到失败单元'),
            failure.incident && h('button',{type:'button',onClick:()=>openEvent(failure.incident)},'查看事件'))))
    }
    function incidentHeadline(signal, observation) {
      if (!observation) return signal + '出现异常'
      const v = typeof observation.value === 'string' ? JSON.parse(observation.value) : observation.value
      if (signal.startsWith(certPrefix)) return signal.slice(certPrefix.length)+' · '+certificateText(v,observation.ts)
      if (signal.startsWith('base · ') && v.note) return signal+' · '+v.note
      if (signal.startsWith('挂载容量 ') && Number.isFinite(v.used_pct))
        return signal.slice(5) + ' 已用空间达到 ' + v.used_pct + '%'
      if (signal === '失败单元' && v.units?.length)
        return v.units[0] + (v.count > 1 ? ' 等 ' + v.count + ' 个单元运行失败' : ' 运行失败')
      if (signal === '代理可用性') return '代理' + (v.edge?.http ? '返回 HTTP ' + v.edge.http : '健康检查失败')
      if (signal === 'SSH 连接') return 'SSH 采集连接异常'
      if (signal === '主机容量') return '主机资源达到告警条件'
      if (signal === '网盘备份') return '网盘备份作业失败'
      if (signal === '备份时效') return '最近可恢复备份已逾期'
      if (signal === '网盘授权') return '百度网盘授权失效'
      if (signal === '可疑 IP') return '同一来源的 SSH 认证失败次数达到阈值'
      if (signal === '内核 OOM') return '内核记录到内存耗尽事件'
      if (signal.startsWith('容器 ')) return signal + ' 运行状态异常'
      if (v.expected_http) return signal + ' 未返回预期的 HTTP ' + v.expected_http
      if (signal.startsWith('业务探针 ')) return signal + (v.status ? ' 返回 HTTP ' + v.status : ' 请求失败')
      return signal + '出现异常'
    }
    function observationNote(signal, observation) {
      if (!observation) return null
      const v = typeof observation.value === 'string' ? JSON.parse(observation.value) : observation.value
      if (signal.startsWith('挂载容量 ') && Number.isFinite(v.available_bytes)) {
        const available = (v.available_bytes / 2 ** 30).toLocaleString('zh-CN', {maximumFractionDigits:2})
        return '可用空间 ' + available + ' GiB' + (Number.isFinite(v.threshold_pct) ? '，告警阈值 ' + v.threshold_pct + '%' : '')
      }
      if (v.origin?.http) return '同次检查的上游响应为 HTTP ' + v.origin.http
      if (signal === '主机容量') return [
        Number.isFinite(v.root_used_pct) && '根卷已用 ' + v.root_used_pct + '%',
        Number.isFinite(v.available_memory_pct) && '可用内存 ' + v.available_memory_pct + '%',
        Number.isFinite(v.load15) && '15 分钟负载 ' + v.load15
      ].filter(Boolean).join(' · ')
      return v.reason || null
    }
    async function request(action, data = {}, serverId) {
      const res = await fetch('/server-operations/api', {
        method: 'POST',
        cache: 'no-store',
        ...(action==='overview' && !data.section ? {signal:AbortSignal.timeout(serverId ? 32_000 : 15_000)} : {}),
        headers: {
          'content-type': 'application/json',
          'x-server-ops': window.location.protocol === 'dsh-app:' && window.location.hostname === 'app'
            ? 'desktop' : '1'
        },
        body: JSON.stringify({ action, data, serverId })
      })
      const r = await res.json().catch(() => ({}))
      if (!res.ok) throw Error(r.error || '读取工作台接口失败（HTTP ' + res.status + '）')
      return r
    }
    function SidebarIcon() {
      const [count, setCount] = R.useState(null)
      R.useEffect(() => {
        let active = true,
          timer
        async function refresh() {
          try {
            const status = await request('connection-status')
            const data = status.legacy ? await request('overview', { section: 'count' }) : {}
            if (active) setCount(data.count ?? data.plans?.length ?? 0)
          } catch {
            if (active) setCount(null)
          }
          if (active) timer = setTimeout(refresh, 15000)
        }
        refresh()
        return () => {
          active = false
          clearTimeout(timer)
        }
      }, [])
      return h(
        'span',
        { 'aria-label': count === null ? '服务器运维' : '待决定 ' + count },
        '▤',
        count > 0 && h('sup', null, count)
      )
    }
    let client
    function OperatorPage({hosts}) {
      const [chosen, setChosen] = R.useState('')
      const host = hosts.includes(chosen) ? chosen : hosts[0] || ''
      return h(WorkspaceChats,{key:host,host,hosts,setChosen})
    }
    // A blank native chat is absent from the conversation list until its first message.
    const unfinishedChats=new Map()
    function WorkspaceChats({host,hosts,setChosen}) {
      const api = useApi()
      const [workspace,setWorkspace]=R.useState(null)
      const [revision,refresh]=R.useState(0)
      const sessions=R.useSyncExternalStore(fn=>client.sessions.list.subscribe(fn),()=>client.sessions.list.getSnapshot())
      const spaces=R.useSyncExternalStore(fn=>client.workspaces.list.subscribe(fn),()=>client.workspaces.list.getSnapshot())
      const [catalog, setCatalog] = R.useState(null)
      const [catalogError,setCatalogError]=R.useState('')
      const [draft, setDraft] = R.useState({provider:'',model:''})
      const [workspaceError,setWorkspaceError]=R.useState('')
      const [actionError,setActionError]=R.useState(null)
      const [pending,setPending]=R.useState(false)
      const lock=R.useRef(false)
      const visible=R.useRef(false)
      R.useEffect(()=>{
        visible.current=true
        return ()=>{visible.current=false}
      },[])
      const catalogRequest=R.useRef(0)
      const loadCatalog = async () => {
        const request=++catalogRequest.current
        try {
          const c = await api('agent-models')
          if(request!==catalogRequest.current)return
          setCatalog(c)
          setDraft(c.selection || {provider:'',model:''})
          setCatalogError('')
        } catch(e) {
          if(request===catalogRequest.current)setCatalogError(e.message)
        }
      }
      R.useEffect(()=>{loadCatalog()},[])
      R.useEffect(()=>{
        if (!host) return
        let live=true, timer
        async function load() {
          try {
            const result=await api('agent-workspace',{host})
            await client.sessions.refresh()
            if(live) {
              setWorkspace(result);setWorkspaceError('')
              if(result.pendingImport) timer=setTimeout(load,4000)
            }
          } catch(e) {if(live) setWorkspaceError(e.message)}
        }
        load()
        return ()=>{live=false;clearTimeout(timer)}
      },[host,revision])
      async function act(work) {
        if (lock.current) return
        lock.current=true;setPending(true);setActionError(null)
        try { await work() } catch(e) { setActionError({message:e.message,retry:work}) }
        finally { lock.current=false;setPending(false) }
      }
      async function newChat() {
        const {workspaceId}=workspace
        let chat=unfinishedChats.get(workspaceId)
        if (!chat) {
          chat={id:null,ready:null}
          unfinishedChats.set(workspaceId,chat)
        }
        // Share preparation if the workspace is reopened while the request is pending.
        chat.ready ??= (async()=>{
          chat.id ??= await client.sessions.create({workspaceId,agentPreset:'server-ops-chat'})
          await api('agent-workspace-model',{host,session:chat.id})
        })().catch(e=>{
          chat.ready=null
          if (!chat.id) unfinishedChats.delete(workspaceId)
          throw e
        })
        await chat.ready
        if (!visible.current) return
        await client.uiWorkspace.openSession(chat.id)
        unfinishedChats.delete(workspaceId)
      }
      const provider=catalog?.providers.find(p=>p.id===draft.provider)
      const active=catalog?.selection || catalog?.default
      const dirty=(catalog?.selection?.provider || '')!==draft.provider ||
        (catalog?.selection?.model || '')!==draft.model
      const space=spaces.items.find(item=>item.workspaceId===workspace?.workspaceId)
      const chats=(space?.sessionIds || []).filter(id=>!spaces.archivedSessionIds.includes(id))
        .map(id=>sessions.byId[id]).filter(s=>s && !s.blank && s.projectionValues?.agentPreset==='server-ops-chat')
        .sort((a,b)=>b.updatedAt-a.updatedAt)
      const control = (label, fn, disabled = false, primary = false) =>
        h('button', {type:'button', disabled:pending || disabled,
          className:primary ? 'ops-primary' : '', onClick:()=>act(fn)}, label)
      const activeProvider = catalog?.providers.find(p=>p.id===active?.provider)
      const validDraft = !draft.provider || provider?.models.some(m=>m.id===draft.model)
      return h('section',{className:'ops-studio'},
        h('div',{className:'studio-work'},
          h('section',{className:'studio-card'},
            h('div',{className:'studio-card-head'},h('h3',null,'运维会话'),
              h('label',{className:'studio-host'},'主机',h('select',{value:host,disabled:pending || !host,
                onChange:e=>setChosen(e.target.value)},...hosts.map(id=>h('option',{key:id,value:id},id))))),
            h('div',{className:'studio-actions'},control(unfinishedChats.has(workspace?.workspaceId)?'继续打开运维会话':'新建运维会话',newChat,!workspace,true)),
            h('p',null,'发出第一条消息后，可以从左侧工作区继续这次对话。'),
            !workspace && !workspaceError && h('p',null,host ? '正在读取工作区…' : '尚无已登记的主机。'),
            workspace?.pending?.map((row,i)=>h('p',{key:i},(status[row.status] || row.status)+' · '+row.question)),
            workspace && h('h3',null,'继续会话'),
            workspace && !chats.length && h('p',null,'还没有已发送消息的会话。'),
            ...chats.map(s=>h('button',{key:s.id,type:'button',className:'ops-session-row',
              onClick:()=>client.uiWorkspace.openSession(s.id)},s.displayTitle))),
          h('aside',{className:'studio-card studio-model','aria-label':'调查模型'},
            h('div',{className:'studio-card-head'},h('h3',null,'调查模型'),active && h('span',{className:'ops-badge ok'},catalogError?'上次读取':'当前生效')),
            catalogError && h('p',{role:'alert'},catalogError,'　',control('重试读取模型配置',loadCatalog)),
            h('strong',{className:'studio-model-name'},active?.model || '尚未读取'),
            h('p',{className:'studio-model-meta'},active && (activeProvider?.name || active.provider),
              active && (' · '+(catalog.selection ? '运维专用' : '跟随桌面默认'))),
            h('details',{className:'studio-settings'},h('summary',null,'切换模型',dirty && ' · 未保存'),
              h('div',{className:'studio-settings-body'},
                catalog && h('label',null,'供应商',h('select',{value:draft.provider,disabled:pending,onChange:e=>{
                  const p=catalog.providers.find(p=>p.id===e.target.value)
                  setDraft({provider:p?.id || '',model:p?.models[0]?.id || ''})
                }},h('option',{value:''},'跟随 DSH 桌面默认'),...catalog.providers.map(p=>h('option',{key:p.id,value:p.id},p.name)))),
                draft.provider && h('label',null,'模型',h('select',{value:draft.model,disabled:pending,
                  onChange:e=>setDraft({...draft,model:e.target.value})},
                  ...(provider?.models || []).map(m=>h('option',{key:m.id,value:m.id},m.id)))),
                dirty && h('p',{className:'studio-draft'},'待应用 · '+(draft.provider ? draft.model : '跟随桌面默认')),
                h('div',{className:'studio-settings-buttons'},
                  dirty && control('保存并应用',async()=>{
                    await api('agent-model',{selection:draft.provider ? draft : null})
                    await loadCatalog()
                  },!validDraft,true),
                  dirty && control('撤销选择',()=>setDraft(catalog.selection || {provider:'',model:''})),
                  !dirty && control('重新读取 DSH 配置',loadCatalog)),
                h('p',null,'保存后用于下一次本机主动排查和告警调查。'))))),
        workspaceError && h('p',{role:'alert'},workspaceError,'　',control('重新读取工作区',()=>refresh(v=>v+1))),
        actionError && h('p',{role:'alert'},actionError.message,'　',control('重试',actionError.retry)))
    }
    function NightWardenHandoff({id,refresh}) {
      const api = useApi()
      const [open,setOpen]=R.useState(false);
      const [loading,setLoading]=R.useState(false);
      const [sending,setSending]=R.useState(false);
      const [data,setData]=R.useState(null);
      const [error,setError]=R.useState('');
      const [note,setNote]=R.useState('');
      const [pending,setPending]=R.useState(null);
      const [now,setNow]=R.useState(Date.now());
      const lock=R.useRef(false);
      const blank=v=>v===null||v===undefined||(typeof v==='string'&&!v.trim());
      const text=v=>blank(v)?'未提供':String(v);
      const stamp=v=>{
        if(blank(v))return NaN;
        const n=typeof v==='number'?v:(typeof v==='string'&&v.trim()!==''?Number(v):NaN);
        return Number.isFinite(n)&&n>0&&Number.isFinite(n*1000)?n*1000:NaN;
      };
      const time=v=>{
        if(blank(v))return '未提供';
        if(!Number.isFinite(stamp(v)))return '无效时间';
        try{return text(fmt(v));}catch(e){return '时间格式无法显示';}
      };
      const choiceText=v=>v==='approve'?'同意转人工排查':v==='reject'?'拒绝转人工排查':text(v);
      const p=data&&data.proposal;
      const receipt=data&&data.receipt;
      const expiry=stamp(p&&p.expiresAt);
      const validExpiry=Number.isFinite(expiry);
      const expired=validExpiry&&expiry<=now;
      const canDecide=!!(p&&!blank(p.id)&&p.status==='pending'&&data.eligible===true&&!receipt&&validExpiry&&!expired);

      async function load(){
        if(lock.current)return;
        lock.current=true;
        setOpen(true);
        setLoading(true);
        setError('');
        setNote('');
        setPending(null);
        try{
          const next=await api('nw-proposal',{id});
          setData(next&&typeof next==='object'?next:{});
          setNow(Date.now());
          if(!next||!next.proposal)setError('提案内容为空，不能提交转人工决定；可重新获取，查询不会改变服务器。');
        }catch(e){
          setData(null);
          setError('网络错误，暂时无法获取转人工排查提案；可重试查询，查询不会改变服务器。');
        }finally{
          lock.current=false;
          setLoading(false);
        }
      }

      async function decide(choice){
        if(lock.current||!canDecide)return;
        const latest=stamp(p&&p.expiresAt);
        if(!Number.isFinite(latest)){
          setError('提案缺少有效的安全到期时间，未发送决定。');
          return;
        }
        if(latest<=Date.now()){
          setNow(Date.now());
          setError('提案已过期，未发送决定。');
          return;
        }
        const request=pending&&pending.choice===choice?pending:{choice,requestId:crypto.randomUUID()};
        setPending(request);
        setSending(true);
        setError('');
        setNote('');
        lock.current=true;
        try{
          const result=await api('nw-handoff',{id,proposalId:p.id,choice,requestId:request.requestId});
          const r=result&&result.receipt&&typeof result.receipt==='object'?result.receipt:
            result&&(!blank(result.choice)||!blank(result.actor)||!blank(result.decidedAt))?result:null;
          if(!r||(blank(r.choice)&&blank(r.actor)&&blank(r.decidedAt))){
            setError('服务器未返回可读的转人工决定回执，决定状态尚未确认；请仅用同一选择重试，请求编号会保持不变。');
            return;
          }
          setData(prev=>Object.assign({},prev,{receipt:r}));
          setPending(null);
          setNow(Date.now());
          setNote('转人工排查决定已记录；本组件不执行任何服务器变更。');
          try{
            if(typeof refresh==='function')await refresh();
          }catch(e){
            setNote('决定已记录，但概要或详情刷新失败；决定回执仍可在本页及证据时间线读取。');
          }
        }catch(e){
          setNow(Date.now());
          setError('提交因网络错误、提案过期或服务器拒绝而未确认。若刚才是传输失败，只能用同一选择重试，并沿用同一请求编号。');
        }finally{
          lock.current=false;
          setSending(false);
        }
      }

      R.useEffect(()=>{
        if(!open||receipt)return undefined;
        const timer=setInterval(()=>setNow(Date.now()),1000);
        return()=>clearInterval(timer);
      },[open,!!receipt]);

      if(!open)return h('div',null,btn('查看转人工排查提案',load,loading));
      let guard='';
      if(!receipt){
        if(!p)guard='提案内容为空，不能提交转人工决定。';
        else if(blank(p.id))guard='提案编号为空，不能安全提交决定。';
        else if(data.eligible!==true)guard='当前不符合转人工排查条件，只能查看提案，不能提交决定。';
        else if(!validExpiry)guard='提案缺少有效的安全到期时间，不能提交决定。';
        else if(expired)guard='提案已过期，不能提交决定。';
      }
      const business=!data?'':data.businessRecovered===true?'业务已恢复。':data.businessRecovered===false?'业务尚未恢复。':'业务恢复状态未提供。';
      const incompleteReceipt=receipt&&(blank(receipt.choice)||blank(receipt.actor)||blank(receipt.decidedAt));
      const mayReload=!loading&&!receipt&&!pending&&(!data||!p||blank(p&&p.id)||!validExpiry||expired);
      return h('section',null,
        h('h4',null,'转人工排查提案'),
        h('p',null,'这里只记录转人工排查决定，不执行服务器变更；业务状态与决定状态分别展示。'),
        loading?h('p',null,'正在获取提案，请稍候…'):null,
        error?h('p',null,error):null,
        note?h('p',null,note):null,
        mayReload?btn(data?'重新获取提案':'重试获取提案',load,false):null,
        p?h('dl',null,
          h('dt',null,'提案编号'),h('dd',null,text(p.id)),
          h('dt',null,'摘要'),h('dd',null,text(p.summary)),
          h('dt',null,'排查动作'),h('dd',null,text(p.action)),
          h('dt',null,'状态'),h('dd',null,text(p.status)),
          h('dt',null,'主机'),h('dd',null,text(p.host)),
          h('dt',null,'容器'),h('dd',null,text(p.container)),
          h('dt',null,'安全到期时间'),h('dd',null,time(p.expiresAt))
        ):null,
        data?h('p',null,business+' 该业务状态不代表已经作出转人工决定。'):null,
        receipt?h('div',null,
          h('h5',null,'转人工排查决定回执'),
          h('p',null,'choice：'+choiceText(receipt.choice)),
          h('p',null,'actor：'+text(receipt.actor)),
          h('p',null,'decidedAt：'+time(receipt.decidedAt)),
          incompleteReceipt?h('p',null,'回执存在空字段，未知内容已标为“未提供”；请勿重复提交决定。'):null,
          h('p',null,'该决定回执仍可从证据时间线读取；服务器变更仍走原调查。')
        ):guard?h('p',null,guard):null,
        !receipt&&canDecide?h('div',null,
          btn(pending&&pending.choice==='approve'?'重试同意转人工排查':'同意转人工排查',()=>decide('approve'),sending||!!(pending&&pending.choice!=='approve')),
          btn(pending&&pending.choice==='reject'?'重试拒绝转人工排查':'拒绝转人工排查',()=>decide('reject'),sending||!!(pending&&pending.choice!=='reject'))
        ):null,
        sending?h('p',null,'正在提交决定，请勿重复点击。'):null
      );
    }

    function NightWardenDuty(props) {
      const api = useApi()
        const reportsOnly=!!(props&&props.reportsOnly);
        const [ov,setOv]=R.useState(null);
        const [ovErr,setOvErr]=R.useState('');
        const [loading,setLoading]=R.useState(false);
        const [selected,setSelected]=R.useState(null);
        const [detail,setDetail]=R.useState(null);
        const [detailErr,setDetailErr]=R.useState('');
        const [detailLoading,setDetailLoading]=R.useState(false);
        const [question,setQuestion]=R.useState('');
        const [questionId,setQuestionId]=R.useState(null);
        const [sending,setSending]=R.useState(false);
        const [sendErr,setSendErr]=R.useState('');
        const [workspaceId,setWorkspaceId]=R.useState(null);
        const [workspaceBusy,setWorkspaceBusy]=R.useState(false);
        const [workspaceErr,setWorkspaceErr]=R.useState('');
        const [disableBusy,setDisableBusy]=R.useState(false);
        const [disableErr,setDisableErr]=R.useState('');
        const [disableMsg,setDisableMsg]=R.useState('');
        const alive=R.useRef(true);
        const overviewSeq=R.useRef(0);
        const detailSeq=R.useRef(0);
        const questionSeq=R.useRef(0);
        const workspaceSeq=R.useRef(0);
        const disableSeq=R.useRef(0);
        const selectedRef=R.useRef(null);
        const questionInput=R.useRef(null);
        function errorText(e) { return e&&e.message?e.message:String(e); }
        function statusText(value) {
            const raw=String(value==null?'':value);
            const key=raw.toLowerCase();
            const names={online:'在线',offline:'离线',running:'正在调查',pending:'等待处理',queued:'排队中',completed:'已完成',complete:'已完成',done:'已完成',success:'成功',succeeded:'成功',failed:'失败',error:'错误',cancelled:'已取消',canceled:'已取消',timeout:'超时',waiting:'等待中',action_required:'需要操作',resolved:'已解决',stopped:'已停止',not_started:'未开始',unknown:'状态未知',enabled:'已启用',disabled:'已停用',active:'生效中',inactive:'未生效'};
            return names[key]||raw||'状态未知';
        }
        function eventStatus(event) { return event&&event.needsDecision?'待人工决策':statusText(event&&event.status); }
        function loadOverview() {
            const seq=++overviewSeq.current;
            setLoading(true);
            setOvErr('');
            return api('nw-overview',{}).then(function(data) {
                if(!alive.current||seq!==overviewSeq.current) return;
                setOv(data);
                setLoading(false);
            }).catch(function(e) {
                if(!alive.current||seq!==overviewSeq.current) return;
                setOv(null);
                closeEvent();
                setOvErr(errorText(e)+'；为避免权限变更后留存旧数据，已隐藏此前的值班内容。');
                setLoading(false);
            });
        }
        function loadEvent(id) {
            const seq=++detailSeq.current;
            setDetailLoading(true);
            setDetailErr('');
            return api('nw-event',{id:id}).then(function(data) {
                if(!alive.current||seq!==detailSeq.current||selectedRef.current!==id) return;
                setDetail(data);
                setDetailLoading(false);
            }).catch(function(e) {
                if(!alive.current||seq!==detailSeq.current||selectedRef.current!==id) return;
                setDetail(null);
                questionSeq.current++;
                workspaceSeq.current++;
                setSending(false);
                setQuestionId(null);
                setWorkspaceBusy(false);
                setDetailErr(errorText(e)+'；已隐藏此前的事件内容，以免权限变更后继续显示。');
                setDetailLoading(false);
            });
        }
        function openEvent(id) {
            if(!id) return;
            questionSeq.current++;
            workspaceSeq.current++;
            selectedRef.current=id;
            setSelected(id);
            setDetail(null);
            setDetailErr('');
            setQuestion('');
            setQuestionId(null);
            setSending(false);
            setSendErr('');
            setWorkspaceId(null);
            setWorkspaceBusy(false);
            setWorkspaceErr('');
            loadEvent(id);
        }
        function closeEvent() {
            questionSeq.current++;
            workspaceSeq.current++;
            detailSeq.current++;
            selectedRef.current=null;
            setSelected(null);
            setDetail(null);
            setDetailErr('');
            setDetailLoading(false);
            setSending(false);
            setSendErr('');
            setWorkspaceBusy(false);
            setWorkspaceErr('');
        }
        function refresh() {
            loadOverview();
            if(selectedRef.current) loadEvent(selectedRef.current);
        }
        async function openWorkspace() {
            const id=selectedRef.current;
            if(!id||!detail||receipt||workspaceBusy) return;
            const seq=++workspaceSeq.current;
            setWorkspaceBusy(true);
            setWorkspaceErr('');
            try {
                const result=await api('nw-workspace',{id:id});
                await client.sessions.refresh();
                if(!alive.current||seq!==workspaceSeq.current||selectedRef.current!==id) return;
                setWorkspaceId(result.workspaceId||null);
                client.uiWorkspace.openSession(result.session);
                setWorkspaceBusy(false);
            } catch(e) {
                if(!alive.current||seq!==workspaceSeq.current||selectedRef.current!==id) return;
                setWorkspaceBusy(false);
                setWorkspaceErr('打开 DSH 工作区失败：'+errorText(e));
            }
        }
        function disableRule() {
            const rule=ov&&ov.rule;
            if(!rule||!rule.enabled||!ov.dutyOnline||disableBusy) return;
            const ruleId=rule.ruleId;
            const seq=++disableSeq.current;
            setDisableBusy(true);
            setDisableErr('');
            setDisableMsg('');
            api('nw-disable',{ruleId:ruleId}).then(function() {
                if(!alive.current||seq!==disableSeq.current) return;
                setDisableBusy(false);
                setDisableMsg('规则已停用；后续事件将进入人工审批。');
                return loadOverview();
            }).catch(function(e) {
                if(!alive.current||seq!==disableSeq.current) return;
                setDisableBusy(false);
                setDisableErr('停用规则失败：'+errorText(e));
            });
        }
        function sendQuestion() {
            const id=selectedRef.current;
            const text=question.trim();
            const current=ov&&id?(ov.events||[]).filter(function(e){return e.id===id;})[0]:null;
            const stale=!!(current&&detail&&Number(current.updated)>Number(detail.updated));
            if(!id||!text||!detail||receipt||sending||!ov.online||!detail.online||detail.status==='running'||detail.needsDecision||stale) return;
            const cid=questionId||crypto.randomUUID();
            const seq=++questionSeq.current;
            setQuestionId(cid);
            setSending(true);
            setSendErr('');
            api('nw-question',{id:id,message:text,clientMessageId:cid}).then(function() {
                if(!alive.current||seq!==questionSeq.current||selectedRef.current!==id) return;
                setSending(false);
                setQuestion('');
                setQuestionId(null);
                loadEvent(id);
            }).catch(function(e) {
                if(!alive.current||seq!==questionSeq.current||selectedRef.current!==id) return;
                setSending(false);
                setQuestionId(cid);
                setSendErr(errorText(e)+'；原问题及草稿已保留，重试将继续使用同一消息 ID。');
            });
        }
        R.useEffect(function() {
            alive.current=true;
            loadOverview();
            return function() {
                alive.current=false;
                overviewSeq.current++;
                detailSeq.current++;
                questionSeq.current++;
                workspaceSeq.current++;
                disableSeq.current++;
            };
        },[]);
        const current=ov&&selected?(ov.events||[]).filter(function(e){return e.id===selected;})[0]:null;
        const stale=!!(current&&detail&&Number(current.updated)>Number(detail.updated));
        const online=!!(ov&&ov.online&&detail&&detail.online);
        const ready=!!(detail&&detail.status!=='running'&&!detail.needsDecision);
        const awaiting=!!detail?.needsDecision;
        const receipt=!!(detail&&(detail.readOnly===true||String(detail.id||selected||'').indexOf('duty:')===0));
        const receiptText=detail?(detail.receipt==null?detail.summary:detail.receipt):null;
        const controls=h('div',{className:reportsOnly?'duty-report-head':'ops-controls'},
            h(reportsOnly?'h3':'h2',null,reportsOnly?'独立值班日报':'NightWarden · VPS 值班'),
            selected?btn(reportsOnly?'返回值班日报':'返回事件列表',closeEvent,false,'ops-primary'):null,
            btn('刷新',refresh,loading,'brief-link')
        );
        if(!ov) return h('section',{className:'brief-section night-warden-duty'},controls,
            ovErr?h('p',{className:'brief-incident'},'读取失败：'+ovErr):h('p',null,'正在读取值班状态…'));
        if(!ov.configured) return h('section',{className:'brief-section night-warden-duty'},controls,'VPS 常驻值班尚未接入');
        const capacityNode=function(capacity) {
            if(!capacity) return h('div',{className:'duty-capacity'},h('strong',null,'容量'),h('small',null,'暂无容量样本。'));
            return h('div',{className:'duty-capacity'},h('strong',null,'容量'),
                h('p',{className:'duty-reading'},capacity.usedPct==null?'占用未知':Number(capacity.usedPct).toLocaleString('zh-CN',{maximumFractionDigits:1})+'%',
                    capacity.path && h('span',null,'　'+capacity.path)),
                capacity.at && h('small',null,'采样于 '+fmt(capacity.at)),
                capacity.at && capacity.previousAt && h('small',null,'较 '+fmt(capacity.previousAt)+' 可用空间变化：'+(capacity.availableChange==null?'未提供':capacity.availableChange+' 字节')));
        };
        const allReports=ov.reports||[];
        function renderReport(report) {
            const missing=report.missing||[];
            const events=report.events||[];
            return h('article',{className:'duty-report',key:report.end},
                h('h4',null,'值班窗口 · '+fmt(report.end).split(' ')[0]),
                h('div',{className:'duty-times'},h('span',null,fmt(report.from)+' 至 '+fmt(report.end)+'（北京时间）'),
                    h('span',null,'生成于 '+(report.generated?fmt(report.generated):'未知'))),
                report.summary && h('p',{className:'duty-summary'},report.summary),
                h('details',null,h('summary',null,'缺测记录（'+missing.length+' 段）'),
                    missing.length?h('ul',null,missing.map(function(gap,i){return h('li',{key:i},fmt(gap.from)+' 至 '+fmt(gap.until));})):h('p',null,'本报告窗口没有缺测记录。')),
                h('div',{className:'duty-body'},capacityNode(report.capacity),
                    events.length>0 && h('div',{className:'duty-events'},h('strong',null,'关联事件 · '+events.length),
                        events.map(function(event){
                            const match=(ov.events||[]).find(item=>item.id===event.id);
                            return h('div',{className:'duty-event',key:event.id},
                                h('span',null,event.title,h('small',null,match?.updated?'更新于 '+fmt(match.updated):'事件 '+event.id.slice(-8))),
                                btn('查看原事件',function(){openEvent(event.id);},false,'brief-link'));
                        }))));
        }
        const eventNodes=reportsOnly||selected?null:h('div',{className:'duty-event-list'},
            h('h3',null,'值班事件'),
            (ov.events||[]).length?(ov.events||[]).map(function(event) {
                return h('article',{className:'brief-incident',key:event.id},
                    h('strong',null,event.title),
                    h('p',null,eventStatus(event)+' · 更新于 '+fmt(event.updated)),
                    btn('查看调查',function(){openEvent(event.id);},false,'brief-link'));
            }):h('p',null,'暂无值班事件。'));
        const rule=ov.rule;
        const ruleNode=h('div',{className:'ops-card'},
            h('h3',null,'演练自动处置规则'),
            rule?h('div',null,
                h('div',null,fact('规则 ID',rule.ruleId||'—'),fact('范围主机',rule.host||'—'),fact('范围容器',rule.container||'—')),
                h('p',null,'规则状态：'+(rule.enabled?'已启用':'已停用')),
                btn(disableBusy?'正在停用':'停用这条规则',disableRule,!rule.enabled||!ov.dutyOnline||disableBusy,'ops-primary'),
                rule.enabled&&!ov.dutyOnline?h('p',null,'值班规则当前离线，不能在这里停用。'):null,
                disableMsg?h('p',null,disableMsg):null,
                disableErr?h('p',{className:'brief-incident'},disableErr):null):h('p',null,'尚无演练自动处置规则。'));
        const dutyStatusNode=h('div',{className:'ops-card'},
            h('h3',null,'值班服务状态'),
            h('div',null,fact('值班主机',ov.host||'—'),fact('值班在线状态',ov.dutyOnline?'在线':'离线'),fact('值班同步时间',ov.dutySync?fmt(ov.dutySync):'尚无')),
            ruleNode,
            h('p',null,'服务端调查模型：'+(ov.model||'尚未确认'),' ',ov.settingsUrl&&ov.online?h('a',{href:ov.settingsUrl,target:'_blank',rel:'noopener noreferrer'},'设置 VPS 调查模型'):null));
        let detailNode=null;
        if(selected) detailNode=h('article',{className:'ops-card'},
            h('div',{className:'ops-controls'},
                h('h3',null,receipt?'执行回执':'原事件调查'),
                btn(receipt?'刷新回执':'刷新原事件',function(){loadEvent(selected);},detailLoading,'brief-link')),
            detailLoading&&!detail?h('p',null,'正在读取事件…'):null,
            detailErr?h('p',{className:'brief-incident'},'事件读取失败：'+detailErr):null,
            detail?h('div',null,
                h('h3',null,detail.title),
                h('p',null,eventStatus(detail)+' · 更新于 '+fmt(detail.updated)),
                h('p',null,'调查接口：'+(detail.online?'在线':'离线')),
                detail.summary?h('p',null,detail.summary):null,
                detail.linkedId?h('div',{className:'ops-controls'},btn('查看同一调查',function(){openEvent(detail.linkedId);},false,'ops-primary')):null,
                receipt||awaiting?null:h('div',{className:'ops-controls'},
                    btn(workspaceBusy?'正在打开 DSH 工作区':'在 DSH 工作区继续',openWorkspace,workspaceBusy,'ops-primary'),
                    workspaceId?h('span',null,'工作区：'+workspaceId):null),
                workspaceErr?h('p',{className:'brief-incident'},workspaceErr):null,
                !receipt&&!awaiting&&detail.nativeUrl?h('p',null,h('a',{href:detail.nativeUrl,target:'_blank',rel:'noopener noreferrer',className:'ops-primary'},'前往 NightWarden 原调查/审批页'),
                    ' ',h('small',null,'浏览器需单独登录 NightWarden')):null,
                h('h4',null,'证据'),
                (detail.evidence||[]).length?h('ul',null,(detail.evidence||[]).map(function(text,i){return h('li',{key:i},text);})):h('p',null,'暂无证据。'),
                receipt?h('div',null,h('h4',null,'执行回执'),h('p',null,typeof receiptText==='string'?receiptText:JSON.stringify(receiptText))):null,
                h('h4',null,receipt?'回执消息':'调查消息'),
                (detail.messages||[]).length?h('div',null,(detail.messages||[]).map(function(text,i){return h('p',{key:i},text);})):h('p',null,receipt?'暂无回执消息。':'暂无调查消息。'),
                receipt?h('div',null,h('p',null,'这是值班回执，可从证据时间线读取；服务器变更仍走原调查。'),detail.needsDecision&&ov.dutyOnline&&detail.online?h(NightWardenHandoff,{key:selected,id:selected,refresh}):null):h('div',{className:'nw-followup'},
                    h('h4',null,'追问运维值班'),
                    awaiting && h('p',null,'NightWarden 正等待你回应原调查。打开原调查时，浏览器需单独登录 NightWarden。也可以在同一事件的 DSH 会话里继续只读追问。'),
                    h('textarea',{rows:3,ref:questionInput,'aria-label':'追问草稿',value:question,disabled:sending,
                        onChange:function(e){setQuestion(e.target.value);setQuestionId(null);setSendErr('');}}),
                    h('div',{className:'nw-followup-actions'},awaiting ? [
                        detail.nativeUrl && h('a',{key:'respond',href:detail.nativeUrl,target:'_blank',rel:'noopener noreferrer'},'打开 NightWarden 待处理问题'),
                        h('button',{key:'ask',type:'button',className:'ops-primary',disabled:workspaceBusy,onClick:openWorkspace},
                            workspaceBusy?'正在打开 DSH 工作区':'在 DSH 继续只读追问'),
                        question.trim() && h('button',{key:'draft',type:'button',onClick:()=>{
                            questionInput.current?.focus();
                            questionInput.current?.select();
                        }},'选中草稿以复制')
                    ] : btn(sending?'正在发送':'发送追问',sendQuestion,sending||!question.trim()||!online||!ready||stale,'ops-primary')),
                    stale?h('p',null,'事件已有更新，请先刷新原事件；问题草稿已保留。'):null,
                    !online?h('p',null,'当前离线，可继续阅读缓存，问题草稿会保留。'):null,
                    online&&!ready&&!awaiting?h('p',null,'调查正在运行。结束后可发送追问，问题草稿会保留。'):null,
                    sendErr?h('p',{className:'brief-incident'},sendErr):null)):null);
        return h('section',{className:'brief-section night-warden-duty'},controls,
            reportsOnly?h('div',{className:'duty-connection'},
                h('b',{className:ov.online?'online':''},ov.online?'调查接口在线':'调查接口离线'),
                h('span',null,ov.host||'主机未知'),h('span',null,'最后同步 '+(ov.lastSync?fmt(ov.lastSync):'尚无')),
                h('span',null,ov.dutyOnline?'值班服务在线':'值班服务离线')):
            h('div',{className:'ops-card'},fact('调查主机',ov.host||'—'),fact('调查在线状态',ov.online?'在线':'离线'),fact('调查最后同步',ov.lastSync?fmt(ov.lastSync):'尚无')),
            ov.online?(reportsOnly?null:h('p',null,'调查接口在线。')):h('p',null,'调查接口离线；以下内容仅在已有缓存时可供阅读，调查最后同步：'+(ov.lastSync?fmt(ov.lastSync):'尚无')+'。'),
            !ov.online&&!ov.lastSync?h('p',{className:'brief-incident'},'当前离线且没有缓存，无法显示此前的调查内容。'):null,
            ov.error?h('p',null,'调查接口状态：'+statusText(ov.error)):null,
            ovErr?h('p',{className:'brief-incident'},'刷新失败，旧数据已隐藏：'+ovErr):null,
            reportsOnly?null:dutyStatusNode,
            eventNodes,
            !selected && !reportsOnly && h('h3',null,'最近一份值班日报'),
            !selected && (allReports.length?renderReport(allReports[0]):h('p',null,'暂无值班日报。')),
            !selected && reportsOnly && allReports.length>1 && h('details',{className:'duty-archive'},
                h('summary',null,'以往值班日报（'+(allReports.length-1)+'）'),allReports.slice(1).map(renderReport)),
            detailNode);
    }

    function openObservation(id) {
      const sample=document.getElementById('observation-'+id)
      if (!sample) return
      sample.closest('.ops-disclosure').open=true
      sample.open=true
      sample.querySelector('summary')?.focus({preventScroll:true})
      sample.scrollIntoView({block:'nearest'})
    }

    function EventTurn({job,parent,canQuote,quoteReply,showReply}) {
      const reply=job.answer ? JSON.parse(job.answer) : {}
      const time=()=>h('time',{dateTime:new Date(job.ts*1000).toISOString()},fmt(job.ts))
      return h('li',{className:'event-turn'},
        job.question && h('div',{className:'event-user-message'},
          h('div',{className:'event-message-meta'},h('b',null,'你'),time()),
          parent && h('button',{type:'button',className:'event-chat-link event-parent-link',
            onClick:()=>showReply(parent)},'引用「'+(parent.question || '主动调查')+'」的回复'),
          h('p',null,job.question)),
        h('article',{className:'event-answer',id:'investigation-'+job.id,tabIndex:-1},
          h('div',{className:'event-message-meta'},
            h('b',null,job.question?'运维 Agent':'运维 Agent · 主动调查'),
            !job.question && time(),
            job.status!=='done' && h('span',{'aria-live':'polite'},
              job.status==='running'?'调查中':(status[job.status] || job.status))),
          reply.finding && h('p',null,reply.finding),
          reply.unknown && h('p',null,h('strong',null,'待核实　'),reply.unknown),
          reply.next && h('p',null,h('strong',null,'建议　'),reply.next),
          reply.error && h('p',null,reply.error),
          (!!reply.evidence?.length || (canQuote && job.status==='done' && reply.finding)) &&
            h('div',{className:'event-answer-actions'},
              !!reply.evidence?.length && h('small',null,'证据'),
              reply.evidence?.map(n=>h('button',{key:n,type:'button',className:'event-cite',
                onClick:()=>openObservation(n)},'#'+n)),
              canQuote && job.status==='done' && reply.finding &&
                h('button',{type:'button',className:'event-chat-link',onClick:()=>quoteReply(job)},'引用回复'))))
    }

    function EventConversation({jobs,canAsk,followup,update,submit}) {
      const transcript=R.useRef(null)
      const input=R.useRef(null)
      const lastSubmit=R.useRef(null)
      const [scrolledUp,setScrolledUp]=R.useState(false)
      const jobsById=new Map(jobs.map(job=>[job.id,job]))
      const parent=jobsById.get(followup.parentId)
      const draft=followup.draft || ''
      const scrollVersion=jobs.map(job=>job.id+':'+job.status).join(',')
      const jumpToLatest=()=>{
        const list=transcript.current
        if (list) list.scrollTop=list.scrollHeight
        setScrolledUp(false)
      }
      R.useLayoutEffect(()=>{
        const sent=followup.sentId && followup.sentId!==lastSubmit.current
        lastSubmit.current=followup.sentId
        if (sent || !scrolledUp) jumpToLatest()
      },[scrollVersion,followup.sentId])
      function quoteReply(job) {
        update({parentId:job?.id ?? null,note:''})
        input.current?.focus()
      }
      function showReply(job) {
        const target=document.getElementById('investigation-'+job.id)
        target?.focus({preventScroll:true})
        target?.scrollIntoView({block:'nearest'})
      }
      if (!canAsk && !jobs.length) return null
      return h('section',{className:'event-conversation','aria-labelledby':'ops-event-conversation'},
        h('div',{className:'event-conversation-heading'},
          h('h3',{id:'ops-event-conversation'},'事件会话'),
          scrolledUp && h('button',{type:'button',className:'event-chat-link',onClick:jumpToLatest},'跳到最新')),
        h('div',{className:'event-transcript',role:'region','aria-label':'会话消息',tabIndex:0,ref:transcript,
          onScroll:ev=>{
            const list=ev.currentTarget
            setScrolledUp(list.scrollHeight-list.clientHeight-list.scrollTop>32)
          }},
          jobs.length ? h('ol',{className:'event-turns'},jobs.map(job=>
            h(EventTurn,{key:job.id,job,parent:jobsById.get(job.parent_id),canQuote:canAsk&&!followup.sending,
              quoteReply,showReply}))) :
            h('p',{className:'event-empty'},'在这里追问，运维 Agent 会结合本事件的观测回答。')),
        canAsk && h('form',{className:'ops-followup','aria-label':'在事件会话中追问',onSubmit:ev=>{
          ev.preventDefault()
          submit(draft,parent?.id)
        }},
          h('div',{className:'event-compose'},
            h('label',{htmlFor:'ops-event-question'},'追问此事件'),
            parent && h('div',{className:'event-quote'},
              h('span',null,'引用「'+(parent.question || '主动调查')+'」的回复'),
              h('button',{type:'button',className:'event-chat-link',disabled:followup.sending,
                onClick:()=>quoteReply(null)},'取消引用')),
            h('div',{className:'ops-followup-row'},
              h('textarea',{id:'ops-event-question',ref:input,rows:2,value:draft,maxLength:600,
                readOnly:!!followup.sending,placeholder:'输入问题，Enter 发送',
                onChange:ev=>update({draft:ev.target.value,note:''}),
                onKeyDown:ev=>{
                  if (ev.key==='Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing && ev.keyCode!==229) {
                    ev.preventDefault()
                    submit(draft,parent?.id)
                  }
                }}),
              h('button',{type:'submit',className:'ops-primary',disabled:followup.sending || !draft.trim()},
                followup.sending?'正在发送…':'发送')),
            followup.note && h('p',{className:'ops-followup-note',role:'alert'},followup.note))))
    }

    function Page() {
      const [connection,setConnection] = R.useState(null)
      const [adding,setAdding] = R.useState(false)
      const [busy,setBusy] = R.useState(false)
      const [error,setError] = R.useState('')
      const [fields,setFields] = R.useState({host:'',port:'22',user:'',fingerprint:'',keyPath:''})
      const refresh = () => request('connection-status').then(value => {
        setConnection(value)
        setError('')
      }, error => setError(error.message))
      R.useEffect(() => { refresh() }, [])
      async function connect(action, data) {
        setBusy(true)
        setError('')
        try {
          setConnection(await request(action, data))
          setAdding(false)
        } catch (error) { setError(error.message) }
        finally { setBusy(false) }
      }
      if (connection?.legacy) return h(Dashboard)
      const active = connection?.active
      const field = (name, label, attributes = {}) => h('label',{key:name},label,h('input',{
        value:fields[name],onChange:e=>setFields({...fields,[name]:e.target.value}),disabled:busy,...attributes
      }))
      const controls = h('section',{className:'ops-connect','aria-label':'服务器连接'},
        active && h('div',{className:'ops-connect-row'},
          h('label',null,'服务器',h('select',{value:active,disabled:busy,
            onChange:e=>connect('connection-select',{serverId:e.target.value})},
            connection.servers.map(server=>h('option',{key:server.serverId,value:server.serverId},
              server.host+' · '+server.endpoint+':'+server.port)))),
          btn(adding ? '取消添加' : '添加服务器',()=>{setAdding(!adding);setError('')},busy)),
        connection && (!active || adding) && h('form',{onSubmit:e=>{
          e.preventDefault()
          if (!busy) connect('connection-add',fields)
        }},
          h('h2',null,'连接 Linux 服务器'),
          h('div',{className:'ops-connect-fields'},
            field('host','SSH 主机',{required:true,placeholder:'server.example.com'}),
            field('port','SSH 端口',{required:true,type:'number',min:1,max:65535}),
            field('user','SSH 用户',{required:true}),
            field('fingerprint','服务器主机指纹',{required:true,placeholder:'SHA256:…'}),
            field('keyPath','本机私钥路径（可选）',{placeholder:'~/.ssh/id_ed25519'})),
          h('button',{type:'submit',className:'ops-primary',disabled:busy},busy ? '正在连接…' : '验证并连接')),
        !connection && (error ? btn('重试读取连接',refresh) : h('p',null,'正在读取连接设置…')),
        error && h('p',{role:'alert'},error))
      const selected = connection?.servers.find(server=>server.serverId===active)
      return active ? h(Connection.Provider,{value:active},h(Dashboard,{
        key:active,connectionControls:controls,connectionRecord:selected
      })) :
        h('main',{className:'ops-panel'},h('style',null,panelStyles),
          h('div',{className:'ops-inner'},h('header',{className:'ops-header'},h('h1',null,'服务器运维')),controls))
    }
    function Dashboard({connectionControls,connectionRecord} = {}) {
      const api = useApi()
      const remote = Boolean(connectionControls)
      const serverId = connectionRecord?.serverId
      const [activity,setActivity] = R.useState(connectionRecord)
      const enabled = feature => !remote || state?.service?.capabilities.includes(feature)
      const [tab, T] = R.useState('值班'),
        [state, S] = R.useState(null),
        [id, I] = R.useState(''),
        [detail, D] = R.useState(null)
      const [reportKey, selectReport] = R.useState('')
      const [eventQuery, setEventQuery] = R.useState('')
      const [recoveredLimit, setRecoveredLimit] = R.useState(recoveredPageSize)
      const [messages, setMessages] = R.useState({}),
        [err, E] = R.useState(''),
        [pending, setPending] = R.useState({}),
        [followups, setFollowups] = R.useState({})
      const sendingQuestions = R.useRef(new Set())
      const [login, L] = R.useState(null),
        [url, U] = R.useState(''),
        [code, C] = R.useState(''),
        [version, V] = R.useState('')
      const [backupHost, H] = R.useState(''),
        [files, F] = R.useState([]),
        [selectedFile, SF] = R.useState('')
      const [member,selectMember] = R.useState('base'), [groupVersion,selectVersion] = R.useState(''),
        [groupFiles,setGroupFiles] = R.useState([]), [groupFile,selectFile] = R.useState('')
      const resetGroupFiles=()=>{setGroupFiles([]);selectFile('')}
      const host = state?.hosts.some(h=>h.id === backupHost) ? backupHost : state?.hosts[0]?.id ?? ''
      const activeEvent = tab==='事件' ? id : ''
      const messageKey = activeEvent ? '事件/'+id : tab
      const msg = messages[messageKey] || ''
      const busy = Boolean(pending[messageKey])
      const M = text => setMessages(previous=>({...previous,[messageKey]:text}))
      const B = value => setPending(previous=>({...previous,[messageKey]:value}))
      const refreshPage = R.useRef(null)
      const [detailError,setDetailError] = R.useState('')
      const pageRoot = R.useRef(null)
      R.useLayoutEffect(() => {
        if (pageRoot.current) pageRoot.current.scrollTop = 0
      }, [id, tab])
      const mounted = R.useRef(true)
      R.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])
      R.useEffect(() => {
        let active = true, timer, sequence = 0
        async function load() {
          const request = ++sequence
          const [summary,event] = await Promise.allSettled([
            api('overview'), activeEvent ? api('event',{id:activeEvent}) : null
          ])
          if (!active || request!==sequence) return
          if (summary.status==='fulfilled') {
            S(summary.value)
            if (serverId) setActivity(summary.value.service)
            E('')
          } else {
            E(summary.reason.message)
            if (serverId) requestConnectionActivity()
          }
          if (event.status==='rejected') {
            D(null)
            setDetailError(event.reason.message)
            return
          }
          const d=event.value
          D(d)
          setDetailError('')
          if (d) setFollowups(previous=>{
            const entry=previous[d.event.id]
            if (!entry?.receipts?.length) return previous
            const receipts=entry.receipts.filter(r=>!d.investigations.some(j=>j.id===r.id))
            return receipts.length===entry.receipts.length ? previous : {...previous,[d.event.id]:{...entry,receipts}}
          })
        }
        async function requestConnectionActivity() {
          const loadSequence = sequence
          try {
            const result = await request('connection-status')
            if (active && loadSequence===sequence) setActivity(result.servers.find(server=>server.serverId===serverId))
          } catch {}
        }
        async function poll() {
          await load()
          if (active) timer=setTimeout(poll,2500)
        }
        refreshPage.current=load
        poll()
        return () => {
          active=false
          refreshPage.current=null
          clearTimeout(timer)
        }
      }, [activeEvent,tab,serverId])
      R.useEffect(() => {
        if (tab !== '备份' || !host || !enabled('backups')) return
        if (host !== 'mac-pilot' && !state?.inventories.some(i=>i.host===host)) return
        let active = true
        api('auth', { host })
          .then((r) => {
            if (active) L(r.authorized)
          })
          .catch((e) => {
            if (active) {
              L(null)
              M(e.message)
            }
          })
        return () => {
          active = false
        }
      }, [tab, host])
      function open(id) {
        I(id)
        D(null)
        setDetailError('')
        T('事件')
        M('')
      }
      function updateFollowup(eventId, patch) {
        setFollowups(previous=>({...previous,[eventId]:{...previous[eventId],...patch}}))
      }
      async function submitFollowup(eventId, draft, parentId) {
        const question=draft.trim()
        if (!question || sendingQuestions.current.has(eventId)) return
        sendingQuestions.current.add(eventId)
        updateFollowup(eventId,{sending:true,note:''})
        try {
          const {qid}=await api('question',{id:eventId,question,...(parentId && {parentId})})
          if (mounted.current) {
            const queued={id:qid,question,parent_id:parentId,status:'queued',ts:Math.floor(Date.now()/1000)}
            setFollowups(previous=>{
              const entry=previous[eventId]
              return {...previous,[eventId]:{...entry,draft:'',parentId:null,sentId:qid,
                receipts:[...(entry?.receipts || []),queued]}}
            })
          }
        } catch (error) {
          if (mounted.current) updateFollowup(eventId,{note:error.message})
        } finally {
          sendingQuestions.current.delete(eventId)
          if (mounted.current) updateFollowup(eventId,{sending:false})
        }
      }
      async function act(work) {
        if (busy) return
        B(true)
        M('')
        try {
          const note = await work()
          if (mounted.current) {
            M(note)
            await refreshPage.current?.()
          }
        } catch (e) {
          if (mounted.current) M(e.message)
        } finally {
          if (mounted.current) B(false)
        }
      }
      const actions = (s, f, disabled = false, kind = '') =>
        btn(s, () => act(f), busy || disabled, kind)
      const card = (key, ...children) =>
        h('article', { key, ...block }, ...children)
      function incidentLabel(e) {
        const sample = state.samples.find(s=>s.host===e.host && s.signal===e.signal)
        const confirmed = !e.closed && sample?.state==='bad' && sample.incident===e.id
        return {title:confirmed ? incidentHeadline(e.signal,sample) : e.signal,
          time:e.closed ? '恢复于 '+fmt(e.closed) : confirmed ? '异常采样 '+fmt(sample.ts) : '等待复核'}
      }
      function incidentRow(e) {
        const {title,time}=incidentLabel(e)
        return h('button',{type:'button',key:e.id,className:'brief-incident',onClick:()=>open(e.id)},
          h('span',null,h('strong',null,title),h('small',null,e.host+' · '+time)),
          h('span',{'aria-hidden':true},'›'))
      }
      function eventList() {
        const terms=eventQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const events=terms.length ? state.events.filter(e=>{
          const {title,time}=incidentLabel(e)
          const text=[title,e.signal,e.host,time,e.closed ? '已恢复' : '持续中'].join(' ').toLowerCase()
          return terms.every(term=>text.includes(term))
        }) : state.events
        const active=events.filter(e=>!e.closed)
        const closed=events.filter(e=>e.closed).sort((a,b)=>b.closed-a.closed)
        const remaining=closed.length-recoveredLimit
        return h('section',{className:'ops-event-list','aria-label':'事件列表'},
          h('label',{className:'ops-event-search'},'搜索事件',
            h('input',{type:'search',value:eventQuery,placeholder:'事件名称、主机或状态',
              onChange:ev=>{setEventQuery(ev.target.value);setRecoveredLimit(recoveredPageSize)}})),
          h('section',{className:'brief-section'},
            h('h3',null,'持续中的事件'),
            active.length ? active.map(incidentRow) : h('p',null,terms.length ? '没有匹配的持续中事件。' : '暂无持续中的事件。')),
          h('section',{className:'brief-section'},
            h('h3',null,'最近恢复的事件'),
            closed.length ? closed.slice(0,recoveredLimit).map(incidentRow) :
              h('p',null,terms.length ? '没有匹配的已恢复事件。' : '暂无恢复记录。'),
            remaining>0 && btn('显示更多（剩余 '+remaining+' 条）',
              ()=>setRecoveredLimit(limit=>limit+recoveredPageSize),false,'ops-event-more')))
      }
      function home() {
        const latest = state.reports[0]
        const active = state.events.filter(e=>!e.closed)
        const closed = state.events.filter(e=>e.closed).sort((a,b)=>b.closed-a.closed)
        const ssh = state.samples.filter(s=>s.signal==='SSH 连接')
        const unconfirmed = remote ? [] : state.hosts.filter(h=>err || !sshOnline(ssh.find(s=>s.host===h.id),state.clock,state.sshInterval))
        const plans = state.plans
        const archive = (label,...children)=>h('details',{className:'brief-fold'},h('summary',null,label),...children)
        const reportDate = latest && fmt(latest.end).split(' ')[0]
        return h('section',{className:'brief-page'},
          ...state.hosts.filter(host=>host.id!=='mac-pilot').map(host=>h(ServerStatus,{
            key:host.id,host:host.id,samples:state.samples.filter(s=>s.host===host.id),
            clock:state.clock,interval:state.sshInterval,disconnected:Boolean(err),openEvent:open,
            service:remote ? {...state.service,lastConnectedAt:activity?.lastConnectedAt,lastSyncedAt:activity?.lastSyncedAt} : state.service})),
          h('header',{className:'brief-lead'},
            h('p',{className:'brief-kicker'},'本机巡检简报',h('span',null,
              err?'上次同步 '+fmt(remote ? activity?.lastSyncedAt : state.clock):'北京时间 '+shortTime(state.clock))),
            h('h2',null,err ? '本机账本暂未更新' : plans.length ? '有 '+plans.length+' 项本机变更等你决定' : '目前没有需要你批准的本机变更'),
            h('p',{className:'brief-deck'},!state.hosts.length ? '尚未登记值班主机。' :
              (err ? '上次同步时，' : '')+(active.length ? '有 '+active.length+' 项异常尚未恢复。' : '账本中没有未关闭的异常。')+
              (remote ? '' : unconfirmed.length ? ' SSH 连通性待确认：'+unconfirmed.map(h=>h.id).join('、')+'。' : ' 最近已连通 '+ssh.map(s=>s.host).join('、')+'。')),
            plans.map(p=>h('div',{className:'brief-plan',key:p.id},h('strong',null,p.body.host+' · '+p.body.target),
              h('p',null,p.body.impact),btn('查看方案并决定',()=>open(p.incident),false,'ops-primary'))),
            enabled('workspace') && btn('问运维 Agent',()=>T('运维 Agent'),false,plans.length?'brief-link':'ops-primary')),
          ...state.hosts.filter(host=>!remote && host.id==='example-host').map(host=>h(ProductionRules,{
            key:'rules-'+host.id,host:host.id,samples:state.samples.filter(s=>s.host===host.id),
            clock:state.clock,interval:state.sshInterval,disconnected:Boolean(err),openEvent:open})),
          enabled('nightwarden') && h(NightWardenDuty),
          active.length>0 && h('section',{className:'brief-section'},
            h('h3',null,'仍需关注'),active.slice(0,2).map(incidentRow),
            active.length>2 && archive('其余 '+(active.length-2)+' 项异常',active.slice(2).map(incidentRow))),
          h('div',{className:'brief-shelf'},
            btn(latest ? '阅读 '+reportDate+' 日报　›' : '查看日报　›',()=>{selectReport('');T('日报')}),
            enabled('backups') && btn('查看备份与恢复　›',()=>T('备份'))),
          latest && enabled('backups') && h('p',{className:'brief-footnote'},latest.host+' · 截至 '+fmt(latest.end)+'，'+
            reportBackup(latest,state.sshInterval).text+'。'),
          archive('值班明细',h('h3',null,'最近恢复的事件'),
            closed.length ? closed.map(incidentRow) : h('p',null,'暂无恢复记录。'),
            h('h3',null,'巡检采样'),
            h('div', {className:'ops-list'}, state.samples.map(s => {
            const cutoff = s.signal === '网盘授权' ? 7230 : s.host === 'mac-pilot' ? 65 : 2 * state.sshInterval + 5
            const stale = s.signal !== '网盘备份' && (Boolean(err) || state.clock - s.ts > cutoff)
            const text = stale ? (s.signal==='SSH 连接'?'连通性待确认':'采集中断') : (s.signal === '网盘备份' ? '上次作业' : '') + (status[s.state] || s.state)
            return h('details', {key:s.host + '/' + s.signal},
              h('summary', null, h('strong', null, s.signal), h('small', {className:'ops-host'}, s.host), badge(text, stale || s.state !== 'ok' ? 'warn' : 'ok')),
              fact('主机', s.host), fact('采样时间', fmt(s.ts)), json(s.value))
          })),
          directoryEvidence()))
      }
      function eventSwitch() {
        const current=detail?.event.id===id ? detail.event : state.events.find(item=>item.id===id)
        const candidates=state.events.filter(item=>(!current || item.host===current.host) && item.id!==id)
        const events=candidates.filter(item=>!item.closed).concat(
          candidates.filter(item=>item.closed).sort((a,b)=>b.closed-a.closed)).slice(0,quickEventLimit)
        const counts=new Map()
        for(const item of current ? [current,...events] : events)
          counts.set(item.signal,(counts.get(item.signal) || 0)+1)
        const label=item=>(current ? '' : item.host+' · ')+item.signal+' · '+(item.closed?'已恢复':'持续中')+
          (counts.get(item.signal)>1 ? ' · '+fmt(item.opened) : '')
        return h('div',{className:'ops-event-tools'},
          btn('返回事件列表',()=>I(''),false,'brief-link'),
          h('label',{className:'ops-switch'},'切换事件',
            h('select',{value:id,disabled:busy || !events.length,onChange:ev=>open(ev.target.value)},
              h('option',{value:id},current ? label(current) : '当前事件'),
              events.map(item=>h('option',{key:item.id,value:item.id},label(item))))))
      }
      function event() {
        if (detailError) return h('p',{role:'alert'},'事件详情暂不可用 · '+detailError)
        if (!detail || detail.event.id !== id)
          return h('p', null, '正在读取事件')
        const e = detail.event
        const abnormal = detail.samples.find(s => s.state === 'bad')
        const latest = detail.samples[0]
        const note = observationNote(e.signal, abnormal)
        const displayState = p => p.status === 'pending' && p.body.expires <= state.clock ? 'expired' : p.status
        const pendingPlans = detail.plans.filter(p => displayState(p) === 'pending')
        const previousPlans = detail.plans.filter(p => displayState(p) !== 'pending')
        const disclosure = (label, count, ...body) =>
          h('details', {className:'ops-disclosure'}, h('summary', null, label,
            h('span', {className:'ops-count'}, count)), ...body)
        const planCard = p => {
          const displayStatus = displayState(p)
          return card(
              p.id,
              h('strong', null, displayStatus === 'pending' ? p.body.impact : (status[displayStatus] || displayStatus)),
              fact('主机与目标', p.body.host + ' / ' + p.body.target),
              fact('固定动作', p.body.action),
              fact('参数', JSON.stringify(p.body.args)),
              fact('依据', '#' + p.body.evidence),
              fact('影响', p.body.impact),
              fact('业务复查', p.body.verify),
              fact('有效期至', fmt(p.body.expires)),
              h('small', null, '摘要 ' + p.digest),
              displayStatus === 'pending' &&
                h(
                  'div',
                  row,
                  ...['approve', 'reject'].map((choice) =>
                    actions(
                      choice === 'approve' ? '批准此计划' : '拒绝此计划',
                      async () => {
                        const r = await api('decide', {
                          id: p.id,
                          digest: p.digest,
                          choice
                        })
                        return status[r.status]
                      }
                    )
                  )
                )
            )
        }
        const followup=followups[e.id] || {}
        const savedIds=new Set(detail.investigations.map(job=>job.id))
        const outstanding=(followup.receipts || []).filter(receipt=>!savedIds.has(receipt.id))
        const canPropose=!e.closed && e.host==='mac-pilot' && e.signal==='代理可用性' &&
          !detail.plans.some(p=>['pending','executing','approved','unknown'].includes(p.status))

        const headline=incidentHeadline(e.signal,abnormal)
        return h('section', {className:'ops-event',key:e.id},
          h('article',{className:'ops-incident-card','aria-labelledby':'ops-current-event'},
          h('header', {className:'ops-incident-hero'},
            h('div', {className:'ops-event-meta'}, h('b', {className:'ops-host'}, e.host),
              badge(e.closed ? '已恢复' : latest?.state === 'unknown' ? '待复核' : '持续中', e.closed ? 'ok' : 'warn')),
            h('h2', {id:'ops-current-event'}, headline),
            note && h('p', {className:'ops-event-note'}, note),
            h('div', {className:'ops-event-meta'},
              h('span',null,'首次告警 ' + fmt(e.opened)),
              h('span',null,e.closed ? '恢复时间 ' + fmt(e.closed) : '异常采样 ' + fmt(abnormal?.ts)),
              latest?.state === 'unknown' && h('span',null,'最近采样缺测'))),
          enabled('approvals') && (pendingPlans.length>0 || canPropose) &&
            h('section', {className:'ops-card ops-decision' + (pendingPlans.length ? ' awaiting' : '')},
            h('h3', null, '需要我决定什么'),
            pendingPlans.map(planCard),
            canPropose &&
            actions('重新提出测试恢复计划', async () => {
              await api('propose', { id })
              return '已生成新计划'
            })),
          h(EventConversation,{jobs:[...detail.investigations,...outstanding],
            canAsk:enabled('investigations'),followup,
            update:patch=>updateFollowup(e.id,patch),
            submit:(draft,parentId)=>submitFollowup(e.id,draft,parentId)})),
          disclosure('观测证据', detail.samples.length + ' 条', fact('事件编号', e.id),
            detail.samples.map((s) =>
            h(
              'details',
              { key: s.id, id: 'observation-' + s.id },
              h(
                'summary',
                null,
                '#' + s.id + ' ' + fmt(s.ts) + '　' + status[s.state]
              ),
              json(JSON.parse(s.value))
            )
          ),
            e.signal.includes('容量') && directoryEvidence(e.host,e.signal.startsWith('挂载容量 ')?e.signal.slice(5):null)),
          previousPlans.length > 0 && disclosure('历史变更计划', previousPlans.length + ' 项', previousPlans.map(planCard)),
          disclosure('执行与审计', detail.audit.length + ' 条',
            detail.audit.map((a) =>
            h(
              'details',
              { key: a.seq },
              h('summary', null, fmt(a.ts) + ' · ' + a.actor + ' · ' + a.kind),
              json(JSON.parse(a.detail))
            )
          ))
        )
      }
      function authorizeButton() {
        return actions(login ? '重新授权' : '授权百度网盘', async () => {
              const r = await api('authorize', { host })
              U(r.url)
              return '请在百度官方页面完成登录'
            })
      }
      function authorizationForm() {
        return url &&
            h(
              'div',
              block,
              h(
                'a',
                { href: url, target: '_blank', rel: 'noreferrer' },
                '打开百度官方登录页'
              ),
              h('input', {
                type: 'password',
                autoComplete: 'off',
                value: code,
                placeholder: '一次性授权码',
                onChange: (e) => C(e.target.value)
              }),
              actions(
                '完成授权',
                async () => {
                  try {
                    const r = await api('finish-login', { host, code })
                    L(r.authorized)
                    U('')
                    return r.authorized ? '授权已验证' : '需要重新授权'
                  } finally {
                    C('')
                  }
                },
                !code
              )
            )
      }
      function groupBackups(inventory) {
        const versions=(state.groups?.versions || []).filter(v=>v.host===host && v.members.includes(member))
        const jobs=(state.groups?.jobs || []).filter(j=>j.host===host)
        const data={host,version:groupVersion,member}
        const restore=(scope,file)=>async()=>{
          const r=await api('group-restore',{...data,member:scope,file})
          return '已校验 '+r.count+' 个文件，恢复至 '+r.dest
        }
        return h('section',{className:'ops-group'},h('h3',null,'四容器测试版本'),
          h('p',null,'数据源为 Mac 专用样本。每个测试版本包含四个容器的模拟镜像、定义、可写层和数据。'),
          h('section',{className:'ops-test-authorization'},fact('Mac 测试备份网盘授权',login===null?'待核对':login?'已授权':'需要登录'),authorizeButton(),authorizationForm()),
          h('div',{className:'ops-group-actions'},
            actions('备份新的测试版本',async()=>{const r=await api('group-publish',{host});selectVersion(r.id);resetGroupFiles();return '云端回读通过 '+r.id},!login,'ops-primary'),
            actions('从网盘核验测试版本',async()=>{const r=await api('group-discover',{host});return '已核验 '+r.count+' 个组版本'},!login)),
          h('div',{className:'ops-group-fields'},
          h('label',null,'容器　',h('select',{value:member,disabled:busy,onChange:e=>{selectMember(e.target.value);resetGroupFiles();M('')}},
            ...inventory.body.containers.map(c=>h('option',{key:c.name,value:c.name},c.name)))),
          h('label',null,'历史版本　',h('select',{value:groupVersion,disabled:busy,onChange:e=>{selectVersion(e.target.value);resetGroupFiles();M('')}},
            h('option',{value:''},'选择组版本'),...versions.map(v=>h('option',{key:v.id,value:v.id},'测试版 '+v.revision+' · '+fmt(v.ts)+' · '+v.id.slice(0,12))))),
          actions('读取容器文件清单',async()=>{const r=await api('group-files',data);setGroupFiles(r.files);selectFile('');return '已读取 '+r.files.length+' 个文件'},!login || !groupVersion),
          groupFiles.length>0 && h('label',null,'历史文件　',h('select',{value:groupFile,disabled:busy,onChange:e=>{selectFile(e.target.value);M('')}},
            h('option',{value:''},'请选择文件'),...groupFiles.map(f=>h('option',{value:f.name,key:f.name},f.name))))),
          h('div',{className:'ops-group-actions'},
            actions('恢复所选文件到新目录',restore(member,groupFile),!login || !groupVersion || !groupFile),
            actions('恢复所选容器到新目录',restore(member,null),!login || !groupVersion),
            actions('恢复整组到新目录',restore(null,null),!login || !groupVersion)),
          h('h3',null,'测试组作业'),...jobs.map(j=>h('details',{key:j.id},h('summary',null,j.operation+' · '+(status[j.status]||j.status)+' · '+fmt(j.ts)),
            j.version && fact('版本',j.version),j.dest && fact('恢复目录',j.dest),j.reason && fact('原因',j.reason),
            typeof j.added==='number' && fact('文件对象','新增 '+j.added+' · 复用 '+j.reused),
            ...Object.entries(j.components).map(([c,value])=>h('p',{key:c},c+' · '+value)),
            j.files && json(j.files))))
      }
      function directoryEvidence(hostFilter,mount) {
        const rows=(state.directories||[]).filter(d=>(!hostFilter || d.host===hostFilter) &&
          (!mount || d.source===mount || d.source.startsWith(mount+'/')))
        return rows.length>0 && h('section',null,h('h3',null,'登记目录空间变化'),
          ...rows.map(d=>h('p',{key:d.host+d.source},d.host+' · '+d.source+' · '+fmt(d.ts)+' · '+
            (d.bytes===null?'缺测 · '+d.reason:d.previous_bytes===null?'首次测得 '+d.bytes+' 字节':
              '变化 '+(d.bytes-d.previous_bytes)+' 字节 · 间隔 '+(d.ts-d.previous_ts)+' 秒'))))
      }
      function changeBackupHost(next) {
        H(next)
        selectVersion('')
        resetGroupFiles()
        V('')
        F([])
        SF('')
        U('')
        C('')
        L(null)
        setMessages(previous=>({...previous,'备份':''}))
      }
      function backups() {
        const inventories = state.inventories || []
        const inventory = inventories.find((i) => i.host === host)
        const selector = h(
          'label',
          null,
          '主机　',
          h(
            'select',
            {
              value: host,
              disabled: busy,
              onChange: e => changeBackupHost(e.target.value)
            },
            ...state.hosts.map(({ id }) => h('option', { key: id, value: id }, id))
          )
        )
        const baseBackup=state.samples.find(s=>s.host===host && s.signal==='base 工作区百度网盘备份')
        const backupCurrent=baseBackup && !err && ['ok','bad'].includes(baseBackup.state) &&
          state.clock-baseBackup.ts<=2*state.sshInterval+5 &&
          sshOnline(state.samples.find(s=>s.host===host && s.signal==='SSH 连接'),state.clock,state.sshInterval)
        if (inventory)
          return h(
            R.Fragment,
            null,
            h('div', {className:'ops-section-head ops-backup-head'}, h('h2', null, '容器保护范围'), selector),
            (baseBackup || host==='example-host') && h('section',{className:'ops-card ops-production-backup'},h('h3',null,'base 工作区 · 生产备份'),
              fact('备份目的地','百度网盘'),
              baseBackup && fact('最近采样',fmt(baseBackup.ts)),
              !baseBackup ? h('p',{role:'status'},'尚无生产备份采样，恢复点待核实。') : !backupCurrent ? h('p',{role:'status'},'生产备份状态待核实 · '+(baseBackup.value?.reason || '等待新采样')) : h(R.Fragment,null,
              fact('VPS 网盘授权',baseBackup.value?.cloud_authorized===true?'最近核验有效':baseBackup.value?.cloud_authorized===false?'需要在 VPS 登录':'待核验'),fact('数据损失目标','最多 24 小时'),
              fact('最近已验证的数据时间',baseBackup.value?.point ? fmt(baseBackup.value.point) : '尚无已验证的工作区版本'),
              fact('网盘恢复验证',baseBackup.value?.verified_at ? fmt(baseBackup.value.verified_at) : '等待'),
              Number.isFinite(baseBackup.value?.elapsed_seconds) && fact('最近完整备份耗时',Math.ceil(baseBackup.value.elapsed_seconds/60)+' 分钟'),
              baseBackup.value?.phase==='uploading' && Number.isFinite(baseBackup.value?.expected_upload_bytes) && fact('已上传并确认',
                (baseBackup.value.uploaded_bytes/2**30).toFixed(2)+' / '+(baseBackup.value.expected_upload_bytes/2**30).toFixed(2)+' GiB'),
              fact('最近作业',({capturing:'拷贝工作区',databases:'生成 SQLite 一致副本',archiving:'加密打包',uploading:'上传并核对分卷',restoring:'从网盘恢复并核对样本',verified:'已验证',failed:'失败，等待重试'})[baseBackup.value?.phase] || '等待首份备份'))),
            !remote && host==='example-host' && h(WorkspaceHistory,{host,api}),
            host==='example-host' && h(GoogleBackup,{host,api}),
            h('p',null,'四容器整组恢复仍需单独验收。'),
            h('details',{className:'brief-fold'},h('summary',null,'测试备份与恢复演练'),groupBackups(inventory)),
            h('details',{className:'brief-fold'},h('summary',null,'查看四个容器的数据与依赖'),fact('只读盘点', fmt(inventory.ts)),
            state.containerEntries.filter(entry => entry.host === host).map(entry =>
              h('p', { key: entry.alias }, 'SSH 入口 ' + entry.alias + ' → ' + entry.container +
                ' · 宿主端口 ' + entry.port + ' → 容器端口 22 · 盘点于 ' + fmt(entry.inventory_ts))
            ),
            inventory.body.containers.map((c) =>
              card(
                c.name,
                h('h3', null, c.name),
                fact('恢复点', '等待组内数据一致性与云端回读验收'),
                fact('镜像', c.observed ? c.tag + ' · ' + c.image : '待核实'),
                fact('网络', Object.keys(c.networks || {}).join('、') || '待核实'),
                (c.mounts || []).map((m) =>
                  h(
                    'p',
                    { key: m.Destination },
                    m.Source +
                      ' → ' +
                      m.Destination +
                      ' · ' +
                      (m.RW ? '可写' : '只读')
                  )
                )
              )
            )
          ))
        if (host !== 'mac-pilot')
          return h(R.Fragment, null, h('h2', null, '备份范围'), selector,
            h('p', null, '该主机尚未登记备份范围。'))
        return h(
          R.Fragment,
          null,
          h('div', {className:'ops-section-head ops-backup-head'}, h('h2', null, '百度网盘备份'), selector),
          h('section', block,
          fact('登记范围', state.source),
          fact('每日备份', state.policy ? '下次到期 ' + fmt(state.policy.due) : '未启用'),
          fact(
            '授权状态',
            badge(login === null ? '待核对' : login ? '已授权' : '需要登录', login ? 'ok' : 'warn')
          ),
          h(
            'div',
            row,
            actions(
              '备份已登记目录',
              async () => {
                const r = await api('backup', { host })
                return '云端回读通过 · ' + r.version
              },
              !login, 'ops-primary'
            ),
            !state.rehearsal && actions(state.policy ? '停用每日备份' : '启用每日备份', async () => {
              const r = await api('schedule-backup', { host, enabled: !state.policy })
              return r.policy ? '下次备份 ' + fmt(r.policy.due) : '已停用后续定时备份'
            }, !state.policy && !login),
            authorizeButton(),
            actions(
              '从云端重建版本索引',
              async () => {
                const r = await api('discover', { host })
                return '已重新核验 ' + r.versions + ' 个版本'
              },
              !login
            )
          ),
          ),
          authorizationForm(),
          h('h3', null, '历史版本'),
          state.versions.length
            ? h(
                'div',
                row,
                h(
                  'select',
                  {
                    'aria-label': '可恢复版本',
                    value: version,
                    disabled: busy,
                    onChange: (e) => {
                      V(e.target.value)
                      F([])
                      SF('')
                      M('')
                    }
                  },
                  h('option', { value: '' }, '选择可恢复版本'),
                  ...state.versions.map((v) =>
                    h(
                      'option',
                      { key: v.id, value: v.id },
                      fmt(v.ts) +
                        ' · ' +
                        v.id.slice(0, 12) +
                        ' · ' +
                        v.files +
                        ' 个文件'
                    )
                  )
                ),
                actions(
                  '查看历史文件',
                  async () => {
                    F((await api('files', { host, version })).files)
                    return '已从云端读取文件清单'
                  },
                  !version || !login
                ),
                files.length > 0 &&
                  h(
                    'select',
                    {
                      'aria-label': '恢复范围',
                      value: selectedFile,
                      disabled: busy,
                      onChange: (e) => { SF(e.target.value); M('') }
                    },
                    h('option', { value: '' }, '恢复整个版本'),
                    ...files.map((n) => h('option', { key: n, value: n }, n))
                  ),
                actions(
                  '恢复到新目录',
                  async () => {
                    const r = await api('restore', {
                      host,
                      version,
                      file: selectedFile || null
                    })
                    return '已验证 ' + r.files.length + ' 个文件　' + r.dest
                  },
                  !version || !login
                )
              )
            : h('p', null, '尚无可恢复版本。'),
          h('h3', null, '作业记录'),
          state.jobs.map((j) =>
            card(
              j.id,
              h('b', null, fmt(j.ts) + ' · ' + status[j.status]),
              fact('阶段', j.stage),
              j.schedule && fact('调度', scheduleText(j.schedule)),
              j.version && fact('版本', j.version),
              j.status === 'verified' &&
                fact('文件内容对象', '新增 ' + j.added + ' · 复用 ' + j.reused),
              j.detail && h('details', null, h('summary', null, '查看作业回执'), json(j.detail))
            )
          )
        )
      }
      function daily() {
        const reports = state.reports
        if (!reports.length) return h('section',{className:'brief-page daily-page'},
          h('header',{className:'daily-front'},h('h2',null,'运维日报'),h('p',null,'等待首份北京时间 07:00 日报。')),
          enabled('nightwarden') && h(NightWardenDuty,{reportsOnly:true}))
        const key = r=>r.host+'/'+r.end
        const r = reports.find(r=>key(r)===reportKey) || reports[0]
        const body = r.body
        const backup=reportBackup(r,state.sshInterval)
        const ongoing = body.cases.filter(c=>!c.closed)
        const closedCount = body.cases.length-ongoing.length
        const ssh = body.ssh_logins
        const completed = body.actions?.filter(a=>a.kind==='调查完成').length
        const reportDay = fmt(r.end).split(' ')[0]
        return h('section',{className:'brief-page daily-page',key:key(r)},
          h('div',{className:'daily-front'},
          h('div',{className:'brief-edition'},h('strong',null,'运维日报'),
            h('label',null,'选择日报',h('select',{value:key(r),onChange:e=>selectReport(e.target.value)},
              reports.map(x=>h('option',{key:key(x),value:key(x)},fmt(x.end).split(' ')[0]+' · '+x.host))))),
          h('header',{className:'brief-lead'},
            h('p',{className:'brief-kicker'},reportDay,h('span',null,r.host+' · 北京时间 07:00 截止')),
            h('h2',null,body.decisions.length ? '截至早上 7 点，有 '+body.decisions.length+' 项待批准变更' :
              ongoing.length ? '截至早上 7 点，有 '+ongoing.length+' 项异常尚未恢复' : '截至早上 7 点，没有待批准的变更'),
            h('p',{className:'brief-deck'},(body.decisions.length ? '' : ongoing.length ? '当时没有待批准的变更。' : '')+
              '报告期内有 '+closedCount+' 项事件恢复。'+(completed ? 'Agent 完成了 '+completed+' 次调查。' : '')),
            r.body.late && h('p',null,'补报于 '+fmt(r.created)),
            body.decisions.length>0 && btn('查看现在待批的变更',()=>T('值班')))),
          h('div',{className:'daily-highlights'},
          ongoing.length>0 && h('section',{className:'brief-section'},h('h3',null,'截至窗口仍需关注'),
            ongoing.map(c=>h('button',{key:c.id,className:'brief-incident',type:'button',onClick:()=>open(c.id)},
              h('span',null,h('strong',null,body.coverage[c.signal]?.last?.state==='bad' ?
                incidentHeadline(c.signal,body.coverage[c.signal].last) : c.signal)),h('span',{'aria-hidden':true},'›')))),
          h('section',{className:'brief-section'},h('h3',null,'值班摘要'),
            ssh && fact('登录安全',(ssh.failures==null?'SSH 认证失败次数未知':'已覆盖日志中有 '+ssh.failures+' 次 SSH 认证失败')+
              (ssh.missing_minutes ? '，仍有 '+ssh.missing_minutes+' 分钟缺测。' : '，已覆盖完整窗口。')),
            enabled('backups') && fact('备份',backup.text))),
          reportCertificates(r),
          body.business?.length>0 && h('section',{className:'brief-section'},h('h3',null,'appnode 业务波动'),
            body.business.map(s=>h('p',{key:s.signal},s.signal+' · '+s.failures+' 次异常采样，最近异常 '+fmt(s.last)))),
          h('details',{className:'brief-fold'},h('summary',null,'查看报告依据与记录'),
              fact('覆盖窗口', fmt(r.body.start) + ' 至 ' + fmt(r.end)),
              fact(r.body.late ? '补报时间' : '生成时间', fmt(r.created)),
              r.body.ssh_logins && fact('SSH 认证失败',
                (r.body.ssh_logins.failures === null ? '未知' : r.body.ssh_logins.failures + ' 次') +
                ' · 有完整日志 ' + r.body.ssh_logins.covered_minutes + ' 分钟，缺测 ' +
                r.body.ssh_logins.missing_minutes + ' 分钟'),
              r.body.ssh_logins?.recovered && h('details',null,h('summary',null,'重连日志补证 · '+r.body.ssh_logins.source),
                ...['recovered','unknown'].flatMap(key=>r.body.ssh_logins[key].map(([a,b])=>
                  h('p',{key:key+a},(key==='recovered'?'日志补证　':'仍未知　')+fmt(a)+' 至 '+fmt(b))))),
              r.body.coverage['fail2ban 既有策略']?.last && fact('最近核对的 fail2ban 封禁数',
                JSON.parse(r.body.coverage['fail2ban 既有策略'].last.value).banned ?? '未知'),
              fact('待决定计划', r.body.decisions.join('、') || '无'),
              enabled('backups') && fact('最近可恢复版本', backup.point?.id || backup.text),
              backup.point && fact('截止时备份数据年龄', snapshotAge(r.end - backup.point.ts)),
              r.body.authorization && fact('最近授权检查', fmt(r.body.authorization.ts) + ' · ' + status[r.body.authorization.state]),
              backup.point?.verified_at && fact('截至窗口的云端核验',fmt(backup.point.verified_at)),
              r.body.disks ? r.body.disks.map(disk =>
                h('details', { key: disk.mount },
                  h('summary', null, '容量 ' + disk.mount + '　' + diskSummary(disk)),
                  disk.first && fact('首条依据', '#' + disk.first.id + ' · ' + fmt(disk.first.ts) + ' · 可用 ' + disk.first.available + ' 字节'),
                  disk.last && fact('末条依据', '#' + disk.last.id + ' · ' + fmt(disk.last.ts) + ' · 可用 ' + disk.last.available + ' 字节')
                )
              ) : fact(
                '容量趋势',
                r.body.diskTrend
                  ? '每天消耗 ' +
                      r.body.diskTrend.bytesPerDay +
                      ' 字节 · 估算剩余天数 ' +
                      (r.body.diskTrend.estimatedDays ?? '未知')
                  : '有效采样不足'
              ),
              enabled('backups') && Boolean(r.body.backupJobs?.length) && h('details',null,
                h('summary',null,'备份作业（' + r.body.backupJobs.length + '）'),
                r.body.backupJobs.map((j) =>
                h(
                  'p',
                  { key: j.id },
                  fmt(j.finished) + ' · ' + j.stage + '　',
                  j.schedule && h('span', null, scheduleText(j.schedule) + '　'),
                  btn('备份记录', () => {if (host!==r.host) changeBackupHost(r.host);T('备份')},Boolean(pending['备份']) && host!==r.host)
                )
              ),
              ),
              Boolean(r.body.actions?.length) && h('details',null,
                h('summary',null,'值班与审计记录（' + r.body.actions.length + '）'),
                r.body.actions.map((a) =>
                h(
                  'p',
                  { key: a.seq },
                  fmt(a.ts) + ' · ' + a.kind + '　',
                  btn('查看原事件', () => open(a.incident))
                )
              ),
              ),
              h('h3',null,'关联事件'),
              r.body.cases.map(c=>h('button',{key:c.id,type:'button',className:'brief-incident',onClick:()=>open(c.id)},
                h('span',null,c.signal+' · '+fmt(c.opened)),h('small',null,c.closed?'已恢复':'截至窗口未恢复'))),
              h('h3',null,'采样与缺测时段'),
              Object.entries(r.body.coverage).map(([signal, c]) =>
                h(
                  'details',
                  { key: signal },
                  h(
                    'summary',
                    null,
                    signal +
                      ' · 最后采样 ' +
                      fmt(c.last?.ts) +
                      ' · 缺测 ' +
                      c.gaps.length +
                      ' 段'
                  ),
                  c.last && json(JSON.parse(c.last.value)),
                  ...c.gaps.map(([a, b]) =>
                    h('p', { key: a }, fmt(a) + ' 至 ' + fmt(b))
                  )
                )
              )
          ),
          enabled('nightwarden') && h(NightWardenDuty,{reportsOnly:true}))
      }
      return h(
        'main', {className:'ops-panel',ref:pageRoot},
        h('style', null, panelStyles),
        h('div', {className:'ops-inner'},
        h('header', {className:'ops-header'},
          h('span', {className:'ops-mark','aria-hidden':true}, h('i'),h('i'),h('i')),
          h('h1', null, '服务器运维')),
        connectionControls,
        state?.rehearsal && h('p', null, '日报演练 · 只读账本副本 · 模拟跨过两个北京时间 07:00'),
        h('nav', {'aria-label':'运维工作台'},
          ['值班', ...(enabled('workspace') ? ['运维 Agent'] : []), ...(enabled('reports') ? ['日报'] : []),
            ...(enabled('backups') ? ['备份'] : []), ...(enabled('events') ? ['事件'] : [])].map(s =>
            h('button', {key:s,type:'button', 'aria-current':tab === s ? 'page' : undefined,
              onClick:()=>{if(tab !== s){T(s);M('')}}},s))),
        err && h('p', { role: 'alert' }, err),
        h('p', { role: 'status' }, busy ? '正在办理…' : msg),
        !state
          ? err && remote ? h('section',{className:'brief-section','aria-label':'上次连接记录'},
              h('p',null,'DSH 最近 SSH 连接 · '+fmt(activity?.lastConnectedAt)),
              h('p',null,'最近同步 · '+fmt(activity?.lastSyncedAt))) :
            !err && h('p', null, remote ? '正在同步服务器采样…' : '正在读取本机账本…')
          : tab === '运维 Agent'
            ? h(OperatorPage, {hosts:state.agentHosts || []})
            : tab === '备份' ? backups()
            : tab === '事件'
              ? (id ? h(R.Fragment,null,eventSwitch(),event()) : eventList())
              : tab === '日报'
                ? daily()
                : home()
      ))
    }
    return {
      inject: ['slots', 'layout','sessions','workspaces','uiWorkspace'],
      apply(ctx) {
        client=ctx
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: panel }, Page)
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: panel,
              order: 42,
              label: () => '服务器运维'
            },
            SidebarIcon
          )
        )
      }
    }
  }
})
