window.__ModuleLoader__.load({
  id: 'dsh-server-ops-agent',
  factory(require) {
    const R = require('react'),
      h = R.createElement
    const panel = 'server-operations'
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
.ops-panel h1, .ops-panel h2, .ops-panel h3, .ops-panel p {margin:0}
.ops-panel h1 {font-size:23px; font-weight:720; letter-spacing:-.06em}
.ops-panel h2 {font-size:19px; font-weight:700; letter-spacing:-.035em; margin:24px 0 10px}
.ops-panel h3 {font-size:16px; font-weight:680; margin:18px 0 8px}
.ops-panel p {margin:8px 0}
.ops-panel nav {display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line);margin:0 0 18px}
.ops-panel button, .ops-panel select, .ops-panel input {
  font:inherit; font-size:13px; color:var(--ink); background:var(--paper); border:1px solid var(--line);
  border-radius:7px; min-height:34px; padding:6px 10px; max-width:100%;
}
.ops-panel button {cursor:pointer; font-weight:580; white-space:normal}
.ops-panel button:hover:enabled, .ops-panel summary:hover {background-color:var(--wash)}
.ops-panel button:disabled, .ops-panel select:disabled {opacity:.55;cursor:default}
.ops-panel :is(button,summary,select,input,a):focus-visible {outline:3px solid #329b97;outline-offset:2px}
.ops-panel nav button {position:relative;min-width:58px;background:transparent;border:0;color:var(--muted);padding:8px 13px;border-radius:5px 5px 0 0}
.ops-panel nav button[aria-current] {color:var(--accent);font-weight:750}
.ops-panel nav button[aria-current]::after {content:"";position:absolute;bottom:-1px;left:10px;right:10px;height:3px;background:var(--accent);border-radius:3px}
.ops-panel .ops-primary {background:var(--accent);color:var(--paper);border-color:var(--accent)}
.ops-panel .ops-primary:hover:enabled {background:var(--accent);filter:brightness(.93)}
.ops-panel [role=status]:empty {display:none}
.ops-panel [role=status]:not(:empty), .ops-panel [role=alert] {padding:10px 12px;border-radius:7px;color:var(--accent);background:var(--wash)}
.ops-panel [role=alert] {color:var(--warn);background:var(--amber)}
.ops-panel time {font-variant-numeric:tabular-nums}
.ops-card {background:var(--paper);border:1px solid var(--line);border-radius:10px}
.ops-card {padding:13px 15px;margin:8px 0}
.ops-card h3:first-child {margin-top:0}
.ops-badge {display:inline-flex;align-items:center;gap:5px;white-space:nowrap;vertical-align:middle;font-size:11px;font-weight:650;padding:2px 7px;border-radius:5px}
.ops-badge::before {content:"";width:5px;height:5px;border-radius:50%;background:currentColor}
.ops-badge.ok {background:var(--wash);color:var(--accent)}
.ops-badge.warn {background:var(--amber);color:var(--warn)}
.ops-panel details.ops-disclosure {background:var(--paper);border:1px solid var(--line);border-radius:9px;margin:7px 0;padding:0 14px}
.ops-panel label {display:block;margin:8px 0;font-size:13px;color:var(--muted)}
.ops-panel label select {margin:0 0 0 6px}
.ops-panel .ops-fact {display:grid;grid-template-columns:minmax(64px,24%) minmax(0,1fr);gap:9px;font-size:13px}
.ops-fact strong {color:var(--muted);font-weight:550}
.ops-panel details {background:var(--paper);border-bottom:1px solid var(--line);padding:0 10px}
.ops-panel summary {padding:9px 0;cursor:pointer;font-size:13px}
.ops-panel pre {overflow:auto;max-height:320px;white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;border-radius:6px;background:var(--canvas);font:12px/1.5 "IBM Plex Mono",ui-monospace,monospace;color:var(--muted)}
.ops-panel small {color:var(--muted)}
@container (max-width:390px) {
  .ops-inner {padding-inline:12px}
  .ops-panel label select {display:block;width:100%;margin:3px 0 0}
  .ops-panel nav {gap:0}
}
@media (prefers-color-scheme:dark) {
  .ops-panel {--canvas:#172327;--paper:#1e2e33;--ink:#e6efef;--muted:#adc1c7;--line:#3d5157;--accent:#8cddd0;--wash:#284641;--warn:#f5c484;--amber:#483a26}
  .ops-panel .ops-primary {color:#10312f}
}
.ops-studio {--night:#16383c;--mint:#9fe8ca;display:grid;gap:20px}
.ops-panel .ops-session-row {display:block;width:100%;text-align:start;padding:12px 14px;margin-top:8px}
.studio-work {display:grid;grid-template-columns:minmax(0,1fr) 280px;align-items:start;gap:16px}
.studio-card {min-width:0;padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--paper)}
.ops-studio h3 {margin:0;font-size:17px;line-height:1.45;letter-spacing:-.02em}
.studio-card-head, .studio-actions {display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.studio-card-head, .studio-actions {justify-content:space-between}
.ops-studio label {margin:0}
.ops-studio .studio-host {display:flex;align-items:center;gap:6px;color:var(--muted)}
.ops-studio .studio-host select {width:auto;margin:0;font:600 13px ui-monospace,monospace}
.ops-studio textarea {width:100%;display:block;margin:14px 0 8px;padding:12px 14px;resize:vertical;min-height:78px;border:1px solid var(--line);border-radius:9px;background:var(--canvas);color:var(--ink);font:inherit}
.ops-studio textarea::placeholder {color:var(--muted)}
.ops-studio textarea:focus-visible {outline:2px solid var(--accent);outline-offset:2px}
.studio-actions {margin-top:12px}
.studio-actions small {font:12px/1.5 ui-monospace,"PingFang SC",monospace;color:var(--muted)}
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
@container (max-width:800px) {
  .studio-work {grid-template-columns:minmax(0,1fr)}
  .studio-model {padding:14px 18px;border-top:1px solid var(--line);border-left:3px solid var(--accent)}
  .studio-model-name {margin:4px 0;font-size:16px}
}
@container (max-width:520px) {
  .ops-studio {gap:14px}
  .studio-work {gap:10px}
  .studio-card {padding:14px}
  .ops-studio :is(button,select,summary) {min-height:44px}
}
.server-chart {margin-bottom:22px;padding:clamp(14px,3cqw,24px);background:var(--paper);border:1px solid var(--line);border-radius:14px;font-variant-numeric:tabular-nums}
.server-chart header, .server-line {display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.server-chart header {border-bottom:1px solid var(--line);padding-bottom:14px;flex-wrap:wrap}
.ops-panel .server-chart h2 {margin:0;font-size:22px}
.server-chart header b {font:600 13px ui-monospace,monospace;color:var(--muted)}
.server-stamp {text-align:end;display:grid;font-size:13px}
.server-resources {display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:clamp(14px,4cqw,36px)}
.server-chart h3 {margin:16px 0 9px}
.server-meter {margin:10px 0 13px}
.server-line, .server-load b {font-size:13px}
.server-line strong {font-size:16px}
.server-track {position:relative;height:8px;margin:4px 0;border-radius:8px;background:var(--line)}
.server-track i {display:block;height:100%;background:var(--accent);border-radius:inherit}
.server-track.high i {background:#c67927}
.server-track em {position:absolute;top:-2px;bottom:-2px;border-left:2px solid var(--ink)}
.server-load {margin-top:12px;display:grid}
.server-load strong {font-size:23px}
.capacity-trend {border-top:1px solid var(--line);padding:14px 0 18px}
.trend-heading {display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.server-chart .trend-heading h3 {margin:0;font-size:16px}
.trend-tabs {display:flex;flex-wrap:wrap;gap:2px;background:var(--canvas);padding:3px;border-radius:7px}
.trend-options {display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ops-panel .server-chart .trend-tabs button {margin:0;text-decoration:none;padding:4px 9px;color:var(--muted)}
.ops-panel .server-chart .trend-tabs button[aria-pressed=true] {background:var(--paper);color:var(--accent);box-shadow:0 1px 3px #0002}
.trend-meta, .trend-foot {font-size:12px;color:var(--muted)}
.trend-plot {display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 9px;margin-top:16px}
.trend-axis {display:flex;flex-direction:column;justify-content:space-between;text-align:right;color:var(--muted);font-size:11px;line-height:1}
.trend-canvas {display:block;width:100%;height:110px;overflow:visible}
.trend-times {grid-column:2;display:flex;justify-content:space-between;color:var(--muted);font-size:11px}
.trend-legend {display:inline-block;width:16px;vertical-align:middle;margin:0 4px 0 8px;border-top:2px dashed #ae650a}
.trend-gap {display:inline-block;width:12px;height:10px;vertical-align:middle;background:var(--line);margin:0 4px 0 8px}
.server-alert {background:var(--amber);color:var(--warn)}
.server-alert {padding:6px 10px;border-radius:6px}
.ops-panel .server-chart button {min-height:24px;padding:0 4px;margin-left:5px;color:var(--accent);font-size:12px;border:0;background:none;text-decoration:underline}
@container (max-width:520px) {
  .server-resources {grid-template-columns:minmax(0,1fr);gap:0}
  .server-stamp {text-align:start}
}
.brief-section {padding:18px 0 5px}
.ops-panel .brief-section h3 {font-size:14px;line-height:1.6;margin:0 0 8px}
.brief-section .ops-fact {grid-template-columns:70px minmax(0,1fr)}
@container (max-width:520px) {
  .brief-section {padding-top:14px}
}
`
    const btn = (s, f, disabled = false, kind = '') =>
      h('button', { type: 'button', onClick: f, disabled, className: kind }, s)
    const fact = (label, value) =>
      h('p', { className: 'ops-fact' }, h('strong', null, label), h('span', null, value))
    const json = (v) =>
      h('pre', null, typeof v === 'string' ? v : JSON.stringify(v, null, 2))
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
    const labels = {ok:'正常',bad:'异常',unknown:'缺测或待核实'}
    function ServerStatus({host, samples, clock, interval, disconnected, openEvent, service}) {
      const [hours,setHours]=R.useState(24)
      const sample = name => samples.find(s => s.signal === name)
      const ssh = sample('本机 SSH 服务')
      const fresh = s => s && Number.isFinite(s.ts) && clock - s.ts <= 2 * interval + 5 && !disconnected
      const connected = !disconnected && fresh(sample('本机采集')) && sample('本机采集').state === 'ok'
      const current = s => connected && fresh(s) && s.state !== 'unknown'
      const capacity = sample('主机容量')
      const mounts = samples.filter(s => s.signal.startsWith('挂载容量 '))
        .sort((a,b) => (b.value?.used_pct ?? -1) - (a.value?.used_pct ?? -1))
      const connection = disconnected ? '同步中断' : '已从服务器同步'
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
      const memory = capacity?.value?.available_memory_pct
      const load = capacity?.value?.load15
      const failure = sample('失败单元')
      const space = s => Number.isFinite(s?.value?.available_bytes) ?
        '可用 '+(s.value.available_bytes / 2**30).toLocaleString('zh-CN',{maximumFractionDigits:2})+' GiB' : '可用空间未知'
      return h('section',{className:'server-chart','aria-label':host+' 服务器现状'},
        h('header',null,h('div',null,h('h2',null,'服务器现状'),h('b',null,host)),
          h('div',{className:'server-stamp'},h('strong',null,connection),
            h('small',null,'服务版本 '+service.version+' · 最近同步 '+fmt(service.lastSyncedAt)),
            h('small',null,'最近服务器采样 · '+fmt(service.latestSample)),
            h('small',null,'DSH 最近 SSH 连接 · '+fmt(service.lastConnectedAt)),
            ssh && h('small',null,'本机 SSH 服务 · '+labels[ssh.state]+' · '+fmt(ssh.ts)))),
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
        current(failure) && failure.state === 'bad' && h('p',{className:'server-alert'},
          '系统服务异常 · '+(failure.value?.units?.join('、') || '检测到失败单元'),
          failure.incident && btn('查看事件',()=>openEvent(failure.incident))))
    }
    async function request(action, data = {}, serverId) {
      const res = await fetch('/server-operations/api', {
        method: 'POST',
        cache: 'no-store',
        ...(action==='overview' && !data.section ? {signal:AbortSignal.timeout(32_000)} : {}),
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
            workspace?.pending?.map((row,i)=>h('p',{key:i},row.status+' · '+row.question)),
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
    function Page() {
      const [connection,setConnection] = R.useState(null)
      const [adding,setAdding] = R.useState(false)
      const [busy,setBusy] = R.useState(false)
      const [error,setError] = R.useState('')
      const [offer,setOffer] = R.useState(null)
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
          if (action === 'connection-add' || action === 'connection-select') setOffer(null)
          const result = await request(action, data)
          if (result.install) {
            setOffer(result.install)
          } else {
            setConnection(result)
            setAdding(false)
            setOffer(null)
          }
        } catch (error) {
          if (action === 'connection-deploy') setOffer(null)
          setError(error.message)
        }
        finally { setBusy(false) }
      }
      const active = connection?.active
      const field = (name, label, attributes = {}) => h('label',{key:name},label,h('input',{
        value:fields[name],onChange:e=>{setOffer(null);setError('');setFields({...fields,[name]:e.target.value})},disabled:busy,...attributes
      }))
      const controls = h('section',{className:'ops-connect','aria-label':'服务器连接'},
        active && h('div',{className:'ops-connect-row'},
          h('label',null,'服务器',h('select',{value:active,disabled:busy,
            onChange:e=>connect('connection-select',{serverId:e.target.value})},
            connection.servers.map(server=>h('option',{key:server.serverId,value:server.serverId},
              server.host+' · '+server.endpoint+':'+server.port)))),
          btn(adding ? '取消添加' : '添加服务器',()=>{setAdding(!adding);setError('');setOffer(null)},busy)),
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
        (!active || adding) && offer && h('section',{className:'ops-card','aria-label':'Linux 部署'},
          h('h3',null,offer.grantOnly ? '授予运维读取权限' : '首次部署 Linux 运维服务'),
          h('p',null,offer.user+' @ '+offer.host+':'+offer.port+
            (offer.grantOnly ? '' : ' · '+offer.version)),
          offer.confirmation ? h(R.Fragment,null,
            h('p',null,offer.grantOnly ? '将 SSH 用户加入 server-ops-read 组，并重新连接。' :
              '需要 root 或免密 sudo。将校验并安装发行包、启用 systemd 服务、授予本账号读取权限，再重新连接。'),
            btn(busy ? '正在部署…' : offer.grantOnly ? '确认授权并连接' : '确认部署并连接',
              ()=>connect('connection-deploy',{confirmation:offer.confirmation}),busy,'ops-primary')) :
            h('p',null,'当前 SSH 账号需要请服务器管理员执行以下命令，再验证并连接。'),
          h('details',{open:!offer.confirmation || undefined},h('summary',null,'管理员安装指引'),
            !offer.grantOnly && h('p',null,h('a',{href:offer.releaseUrl,target:'_blank',rel:'noopener noreferrer'},'下载同版本 Linux 安装包')),
            h('pre',null,offer.instructions))),
        !connection && (error ? btn('重试读取连接',refresh) : h('p',null,'正在读取连接设置…')),
        error && h('p',{role:'alert'},error))
      const selected = connection?.servers.find(server=>server.serverId===active)
      return active ? h(Connection.Provider,{value:active},h(Dashboard,{
        key:active,connectionControls:controls,connectionRecord:selected
      })) :
        h('main',{className:'ops-panel'},h('style',null,panelStyles),
          h('div',{className:'ops-inner'},h('header',{className:'ops-header'},h('h1',null,'服务器运维')),controls))
    }
    function Dashboard({connectionControls,connectionRecord}) {
      const api = useApi()
      const [state,setState] = R.useState(null)
      const [activity,setActivity] = R.useState(connectionRecord)
      const [error,setError] = R.useState('')
      const [tab,setTab] = R.useState('值班')
      const [id,setId] = R.useState(null)
      const [evidence,setEvidence] = R.useState(null)
      const [eventError,setEventError] = R.useState('')
      const [reportEnd,setReportEnd] = R.useState(null)
      R.useEffect(() => {
        let live = true, timer
        async function refresh() {
          try {
            const snapshot = await api('overview')
            if (live) {
              setState(snapshot)
              setActivity(snapshot.service)
              setError('')
            }
          } catch (error) {
            if (live) setError(error.message)
            try {
              const result = await request('connection-status')
              if (live) setActivity(result.servers.find(server=>server.serverId===connectionRecord.serverId))
            } catch {}
          }
          if (live) timer = setTimeout(refresh, 2500)
        }
        refresh()
        return () => { live=false; clearTimeout(timer) }
      }, [api,connectionRecord.serverId])
      R.useEffect(() => {
        if (tab !== '事件' || !id) return
        let live = true
        api('event',{id}).then(result=>{if (live) setEvidence(result)},error=>{
          if (live) setEventError(error.message)
        })
        return () => { live=false }
      }, [api,tab,id])
      function openEvent(eventId) {
        if (eventId !== id) {
          setEvidence(null)
          setEventError('')
          setId(eventId)
        }
        setTab('事件')
      }
      const report = state?.reports.find(row=>row.end===reportEnd) ?? state?.reports[0]
      const eventLink = event => h('p',{key:event.id},btn(event.signal+' · '+fmt(event.opened),()=>openEvent(event.id)),
        ' · '+(event.closed ? '已恢复' : '待核实'))
      return h('main',{className:'ops-panel'},h('style',null,panelStyles),
        h('div',{className:'ops-inner'},
          h('header',{className:'ops-header'},h('h1',null,'服务器运维')),
          connectionControls,
          h('nav',{'aria-label':'运维工作台'},...['值班','运维 Agent','日报',...(id ? ['事件'] : [])].map(name=>
            h('button',{key:name,type:'button','aria-current':name===tab?'page':undefined,onClick:()=>setTab(name)},name))),
          error && h('p',{role:'alert'},error),
          (error || !state) && h('section',{className:'brief-section','aria-label':'上次连接记录'},
            fact('DSH 最近 SSH 连接',fmt(activity?.lastConnectedAt)),
            fact('最近同步',fmt(activity?.lastSyncedAt))),
          !state && !error && h('p',{role:'status'},'正在同步服务器采样…'),
          state && tab === '值班' && h(R.Fragment,null,
            h(ServerStatus,{host:state.service.host,samples:state.samples,clock:state.clock,
              interval:state.sshInterval,disconnected:!!error,openEvent,service:state.service}),
            !state.service.latestSample && !error && h('p',{role:'status'},'正在等待首条容量采样…'),
            h('section',{className:'ops-card'},h('h2',null,'事件'),
              state.events.length ? state.events.map(eventLink) : h('p',null,'暂无事件。'))),
          state && tab === '运维 Agent' && h(OperatorPage,{hosts:state.agentHosts}),
          state && tab === '日报' && h('section',{className:'ops-card'},
            h('h2',null,'运维日报'),
            !report ? h('p',null,'等待首份北京时间 07:00 日报。') : h(R.Fragment,null,
              h('label',null,'选择日报 ',h('select',{value:report.end,onChange:event=>setReportEnd(Number(event.target.value))},
                ...state.reports.map(row=>h('option',{key:row.end,value:row.end},fmt(row.end))))),
              fact('覆盖窗口',fmt(report.body.start)+' 至 '+fmt(report.end)),
              fact('生成时间',fmt(report.created)),
              h('h3',null,'关联事件'),
              report.body.cases.length ? report.body.cases.map(eventLink) : h('p',null,'本窗口无事件。'),
              h('h3',null,'采样与缺测时段'),
              ...Object.entries(report.body.coverage).map(([name,coverage])=>
                h('details',{key:name},h('summary',null,name+' · '+coverage.gaps.length+' 段缺测'),
                  coverage.last && fact('最后采样',fmt(coverage.last.ts)),
                  coverage.last && json(JSON.parse(coverage.last.value)),
                  ...coverage.gaps.map(([start,end])=>h('p',{key:start},fmt(start)+' 至 '+fmt(end))))))),
          state && tab === '事件' && h('section',{className:'ops-card'},
            h('h2',null,evidence?.event.signal ?? '事件'),
            eventError ? h('p',{role:'alert'},eventError) : !evidence ? h('p',null,'正在读取原始观测…') : h(R.Fragment,null,
              fact('事件编号',evidence.event.id),fact('发生时间',fmt(evidence.event.opened)),
              fact('恢复时间',fmt(evidence.event.closed)),
              h('h3',null,'观测证据'),
              ...evidence.samples.map(sample=>h('details',{key:sample.id},h('summary',null,
                '#'+sample.id+' · '+sample.signal+' · '+fmt(sample.ts)+' · '+labels[sample.state]),json(JSON.parse(sample.value))))))))
    }
    return {
      inject: ['slots', 'layout', 'sessions', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        client = ctx
        ctx.slots.inject('main', () => ctx.slots.register({name:'main',key:panel},Page))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({name:'sidebar.panellist',id:panel,order:42,label:()=>'服务器运维'},
            () => h('span',{'aria-hidden':true},'▤')))
      }
    }
  }
})
