"""Read fixed Linux signals. Emit aggregates only. No log bodies leave the host."""
from pathlib import Path
import hashlib
import http.client
import ipaddress
import json
import math
import grp
import os
import re
import socket
import subprocess
import sys
import time

result = {}


def command(*args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=5)
        return p.stdout if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def signal(name, state, **facts):
    result[name] = dict(state=state, facts=facts)


def listener_addresses(listeners):
    addresses = set()
    for line in listeners.splitlines():
        fields = line.split()
        if len(fields) < 5:
            continue
        address = fields[3].rsplit(':', 1)[0].strip('[]')
        if address == '*':
            addresses.update(('127.0.0.1', '::1'))
            continue
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        addresses.add(('::1' if parsed.version == 6 else '127.0.0.1') if parsed.is_unspecified else address)
    return sorted(addresses)


def ssh_identification(address, port):
    deadline = time.monotonic() + 1.25
    try:
        with socket.create_connection((address, port), timeout=1.25) as conn:
            reply = b''
            while len(reply) < 1024:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                conn.settimeout(remaining)
                chunk = conn.recv(1024 - len(reply))
                if not chunk:
                    break
                reply += chunk
                if re.search(rb'(?:^|\n)SSH-(?:2\.0|1\.99)-[!-~]+(?: [\x20-\x7e]*)?\r?\n', reply):
                    return True
    except OSError:
        pass
    return False


# Check the enrolled Linux identity before reading service paths or logs.
machine_id = open('/etc/machine-id', 'rb').read().strip()
if not re.fullmatch(rb'[0-9a-fA-F]{32}', machine_id) or machine_id == b'0' * 32:
    sys.exit(2)
identity = hashlib.sha256(machine_id).hexdigest()
if len(sys.argv) == 4 and sys.argv[3] not in ('unbound', identity):
    print(json.dumps({'identity': identity, 'signals': {}}))
    sys.exit(0)

if sys.argv[1:2] == ['--local']:
    port = int(os.environ.get('SERVER_OPS_SSH_PORT', '22'))
    listeners = command('ss', '-H', '-ltn', 'sport', '=', ':' + str(port))
    listening = None if listeners is None else bool(listeners.strip())
    addresses = listener_addresses(listeners or '')
    if listening is None or (listening and not addresses):
        identified = None
    else:
        identified = any(ssh_identification(address, port) for address in addresses[:8])
    state = 'unknown' if identified is None else 'ok' if identified else 'bad'
    signal('本机 SSH 服务', state, port=port, listening=listening, ssh_identification=identified)

s = os.statvfs('/')
pct = math.ceil(100 * (s.f_blocks - s.f_bfree) / max(1, s.f_blocks - s.f_bfree + s.f_bavail))
inode = round(100 * (s.f_files - s.f_ffree) / max(1, s.f_files))
mem = dict(re.findall(r'^(MemTotal|MemAvailable):\s*(\d+)', open('/proc/meminfo').read(), re.M))
free_pct = round(100 * int(mem['MemAvailable']) / int(mem['MemTotal']))
load15 = round(os.getloadavg()[2], 2)
signal('主机容量', 'bad' if pct >= 85 or inode >= 90 or free_pct < 8 or load15 > os.cpu_count() * 1.5 else 'ok',
       root_used_pct=pct, inode_used_pct=inode, available_memory_pct=free_pct, load15=load15,
       logical_cpu=os.cpu_count(), available_bytes=s.f_bavail*s.f_frsize)
# Run inside base's namespace. Only fixed process states and task counts leave it.
BASE_DEVELOPMENT = r"""const fs = require('fs')
const path = require('path')
const {spawnSync} = require('child_process')
const results = {}
function record(name, state, note) { results[name] = {state, facts:{note}} }

try {
  fs.accessSync('/workspace',fs.constants.R_OK | fs.constants.X_OK)
  record('开发工作区挂载','ok','工作区可访问')
} catch { record('开发工作区挂载','bad','工作区不可访问') }

const supervisor = spawnSync('supervisorctl', ['status'], {encoding:'utf8',timeout:2200})
const states = new Map((supervisor.stdout || '').split('\n').map(line => line.trim().split(/\s+/,2)))
for (const [program, label] of [['task-scheduler','开发调度器'],['sshd','远程 SSH 服务'],
  ['model-router','Codex 模型代理'],['aoe','AoE 会话管理']]) {
  const state = states.get(program)
  record(label, !state ? 'unknown' : state === 'RUNNING' ? 'ok' : 'bad', state || '未取得进程状态')
}

function taskReceipt() {
  const label = '开发任务回执'
  const root = '/workspace/example-tasks/runs'
  if (fs.existsSync('/root/.local/share/task-scheduler/disabled'))
    return record(label,'unknown','调度已手动暂停')
  // A run may span UTC midnight. Only inspect bounded receipt metadata.
  const dirs = fs.readdirSync(root).filter(s => /^20\d{6}$/.test(s)).sort().slice(-2).reverse()
  let receipt
  for (const dir of dirs) {
    const day = path.join(root,dir)
    for (const name of fs.readdirSync(day).filter(s => /^\d{8}T\d{6}Z-/.test(s)).sort().reverse()) {
      const run = path.join(day,name)
      if (fs.existsSync(path.join(run,'ended'))) { receipt=run;break }
    }
    if (receipt) break
  }
  if (!receipt) return record(label,'unknown','尚无已完成轮次')
  const end = Date.parse(fs.readFileSync(path.join(receipt,'ended'),'utf8').trim())
  const rc = fs.readFileSync(path.join(receipt,'rc'),'utf8').trim()
  if (!Number.isFinite(end) || !/^[0-9]+$/.test(rc)) return record(label,'unknown','任务回执格式待核实')
  const age = Math.floor((Date.now()-end)/60000)
  let note = '上轮结束距采样 '+age+' 分钟，退出码 '+rc
  let state = rc==='0' && age<=30 ? 'ok' : 'bad'
  if (age<0) state='unknown'
  const file=path.join(receipt,'stdout.json')
  try {
    if (rc==='0' && fs.statSync(file).size<=65536) {
      const r=JSON.parse(fs.readFileSync(file,'utf8'))
      if (Array.isArray(r.executed) && Array.isArray(r.paused) && Array.isArray(r.errors)) {
        note += (r.dryRun?' · 试运行':'')+' · 执行 '+r.executed.length+'、暂停 '+r.paused.length+'、报错 '+r.errors.length
        if (r.errors.length) state='bad'
      }
    }
  } catch {
    note += ' · 任务计数未取得'
  }
  record(label,state,note)
}
try { taskReceipt() } catch { record('开发任务回执','unknown','无法读取已完成轮次的回执') }

function remoteStatus() {
  const WS = require('ws')
  return new Promise((resolve,reject)=>{
    const ws=new WS('ws+unix:///root/.codex/app-server-control/app-server-control.sock:/',{handshakeTimeout:1800})
    const timer=setTimeout(()=>{ws.terminate();reject(Error('timeout'))},2400)
    ws.on('error',reject)
    ws.on('close',()=>{clearTimeout(timer);reject(Error('closed'))})
    const send=m=>ws.send(JSON.stringify(m))
    ws.on('open',()=>send({id:1,method:'initialize',params:{
      clientInfo:{name:'dsh_duty',version:'1'},capabilities:{experimentalApi:true}}}))
    ws.on('message',buf=>{
      try {
        const msg=JSON.parse(buf)
        if (msg.id===1 && msg.result) {
          send({method:'initialized'})
          send({id:2,method:'remoteControl/status/read'})
        } else if (msg.id===2) {
          resolve(msg.result && msg.result.status)
          ws.close()
        }
      } catch(e) {reject(e);ws.terminate()}
    })
  })
}
async function finish() {
  try {
    const status=await remoteStatus()
    const labels={connected:'已连上远程控制服务',connecting:'正在连接',disconnected:'远程连接已断开',disabled:'远程控制已关闭',errored:'远程连接报错'}
    const state=status==='connected'?'ok':['disconnected','errored','disabled'].includes(status)?'bad':'unknown'
    record('Codex 远程连接',state,labels[status] || '远程状态待核实')
  } catch(e) {
    const unavailable=['ENOENT','ECONNREFUSED'].includes(e.code) && String(e.address||'').endsWith('app-server-control.sock')
    record('Codex 远程连接',unavailable?'bad':'unknown',unavailable?'远程控制套接字不可用':'未取得远程控制状态')
  }
  console.log(JSON.stringify(results))
}
finish()
"""
BASE_CHECKS = ('开发工作区挂载','开发调度器','开发任务回执','Codex 远程连接','Codex 模型代理','AoE 会话管理','远程 SSH 服务')


def inspect_base_development():
    try:
        reply = subprocess.run(['docker','exec','-i','base','/usr/bin/node','-'], input=BASE_DEVELOPMENT,
                               capture_output=True, text=True, timeout=8, check=True)
        rows = json.loads(reply.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        rows = {}
    mount = command('docker','inspect','--type','container','--format',
                    '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}} {{.RW}}{{end}}{{end}}','base')
    if mount is None:
        rows['开发工作区挂载'] = {'state':'unknown','facts':{'note':'挂载身份待核实'}}
    elif mount.strip() != '/data/example-workspace/workspace true':
        rows['开发工作区挂载'] = {'state':'bad','facts':{'note':'工作区挂载来源或读写模式不符'}}
    for label in BASE_CHECKS:
        row = rows.get(label) or {'state':'unknown','facts':{'note':'未取得 base 开发巡检回执'}}
        signal('base · '+label, row['state'], **row['facts'])


def inspect_offsite_backup(baidu, google, now):
    candidates = []
    sources = {}
    known = True
    for name, record in [('baidu', baidu), ('google', google)]:
        point = record.get('started') if record else None
        verified = record.get('verified_at') if record else None
        if name == 'baidu' and record and record.get('status') != 'verified':
            point = verified = None
        valid = type(point) is int and type(verified) is int and 0 < point <= verified <= now
        if valid:
            candidates.append((point, verified))
        elif record is None or point is not None or verified is not None:
            known = False
        sources[name] = point if valid else None
    latest, verified = max(candidates, default=(None, None))
    fresh = latest is not None and now-latest <= 86400
    signal('base 工作区异地备份', 'ok' if fresh else 'bad' if known else 'unknown',
           point=latest, verified_at=verified, sources=sources, target_hours=24)


def inspect_registered_services():
    containers = ('base', 'appnode', 'example-gateway', 'example-site')
    for name in containers:
        data = command('docker', 'inspect', '--type', 'container', '--format',
                       '{{.State.Status}} {{with index .State "Health"}}{{.Status}}{{else}}none{{end}} {{.RestartCount}} {{.Id}}', name)
        fields = data.strip().split() if data else []
        state = 'unknown' if len(fields) != 4 else 'ok' if fields[0] == 'running' and fields[1] in ('healthy', 'none') else 'bad'
        signal('容器 '+name, state, status=fields[:3], container_id=fields[3][:12] if len(fields)==4 else None)
    for name, port in [('base',3080),('appnode',3080),('example-site',8080)]:
        address = command('docker','inspect','--type','container','--format',
                          '{{with index .NetworkSettings.Networks "example-edge"}}{{.IPAddress}}{{end}}',name)
        status, digest = None, None
        started = time.monotonic()
        if address:
            try:
                address = ipaddress.ip_address(address.strip())
                if address.is_private and not address.is_link_local:
                    connection = http.client.HTTPConnection(str(address), port, timeout=3)
                    try:
                        connection.request('GET','/')
                        response = connection.getresponse()
                        status = response.status
                        digest = hashlib.sha256(response.read(65536)).hexdigest()
                    finally:
                        connection.close()
            except (ValueError, OSError, http.client.HTTPException):
                pass
        signal('业务探针 '+name,'unknown' if not address else 'bad' if status is None or status >= 500 else 'ok' if 200 <= status < 400 else 'unknown',
               port=port,status=status,first_64k_sha256=digest,elapsed_ms=round(1000*(time.monotonic()-started)),route='example-edge /')

    backup = '/data/dsh-workspace-archives'
    if os.path.isfile(backup+'/owner'):
        def receipt(name):
            try:
                with open(backup+'/'+name, 'rb') as f:
                    return json.load(f)
            except FileNotFoundError:
                return {}
            except (OSError, ValueError):
                return None
        last, current = receipt('latest.json'), receipt('progress.json')
        google = None
        try:
            identity = hashlib.sha256(Path('/etc/machine-id').read_bytes().strip()).hexdigest()
            raw = command('python3', '-I', '/var/lib/dsh-workspace-private/google_drive.py',
                          'status', identity)
            google = json.loads(raw) if raw else None
        except (OSError, ValueError):
            pass
        inspect_offsite_backup(last, google, int(time.time()))
        baidu_known = last is not None
        last, current = last or {}, current or {}
        point = last.get('started') if last.get('status') == 'verified' else None
        age = int(time.time()) - point if type(point) is int else None
        signal('base 工作区百度网盘备份', 'ok' if age is not None and 0 <= age <= 86400 else 'bad' if baidu_known else 'unknown',
               point=point, verified_at=last.get('verified_at'), age_seconds=age, target_hours=24,
               cloud_authorized=(receipt('cloud-authorization.json') or {}).get('authorized'),
               phase=current.get('status'), started=current.get('started'), verified_objects=current.get('verified_objects'),
               uploaded_bytes=current.get('uploaded_bytes'), expected_upload_bytes=current.get('expected_upload_bytes'),
               elapsed_seconds=(last.get('verified_at')-point) if point and type(last.get('verified_at')) is int else None, note='在线备份，每个 SQLite 数据库单独取一致副本')
    for mounted in ('/data','/srv/appnode'):
        if os.path.ismount(mounted):
            v=os.statvfs(mounted)
            pct=math.ceil(100*(v.f_blocks-v.f_bfree)/max(1,v.f_blocks-v.f_bfree+v.f_bavail))
            signal('挂载容量 '+mounted,'bad' if pct>=85 else 'ok',used_pct=pct,available_bytes=v.f_bavail*v.f_frsize,threshold_pct=85)

    svc = command('systemctl', 'show', '--property=ActiveState', '--value', 'appnode.service')
    signal('appnode.service', 'unknown' if svc is None else 'ok' if svc.strip() == 'active' else 'bad',
           active_state=svc.strip() if svc else None)
    inspect_base_development()
    try:
        domains, routes = registered_sites()
    except (OSError, UnicodeError):
        domains, routes = set(), {target:set() for target in EDGE_TARGETS}
    signal('证书域名清单', 'ok' if domains else 'unknown', count=len(domains), domains=sorted(domains))
    for domain, cert in certificate_observations(domains).items():
        signal('TLS 证书 '+domain, cert['state'], **cert['facts'])
    for target, facts in edge_observations(routes).items():
        if "reason" in facts:
            state = "unknown"
        elif facts["curl_exit"] == 0 and facts["code"] == facts["expected_http"]:
            state = "ok"
        else:
            state = "bad"
        role = "鉴权入口 " if facts["expected_http"] == 401 else "代理入口 "
        signal(role + target, state, **facts)


if sys.argv[1:3] == ['--duty', 'four-services']:
    inspect_registered_services()

end = int(time.time()) // 60 * 60
start = end - 300
lines, full = journal_lines(start, end, 2000)
groups = {grp.getgrgid(i).gr_name for i in os.getgroups()}
visible = os.geteuid() == 0 or bool(groups.intersection({'adm', 'systemd-journal'}))
unit_active = bool(lines) or command('systemctl', 'is-active', '--quiet', 'ssh.service', 'sshd.service', 'ssh.socket', 'sshd.socket') is not None
ban = command('fail2ban-client', 'status', 'sshd') or ''
count = re.search(r'Currently banned:\s*(\d+)', ban)
listed = re.search(r'Banned IP list:[ \t]*([^\r\n]*)', ban)
banned = set(listed.group(1).split()) if listed else None
if banned is not None and (not count or len(banned) != int(count.group(1))):
    banned = None
facts = ssh_failures(lines, start, end, full and visible and unit_active, banned)
state = 'bad' if any(n >= 8 for _, n, _ in facts['top']) else 'ok' if facts['window_complete'] else 'unknown'
signal('可疑 IP', state, **facts, journal_visible=visible, source='sshd journal', threshold=8, max_lines=2000)
signal('fail2ban 既有策略', 'ok' if count else 'unknown', banned=int(count.group(1)) if count else None,
       source='fail2ban sshd jail', checked_at=int(time.time()))
if sys.argv[1:3] == ['--duty', 'four-services']:
    lines, full = log_lines(['docker', 'logs', '--since', str(start), '--until', str(end), '--tail', '1001', 'example-gateway'], 1000)
    proxy = proxy_access(lines, start, end, full)
    rate = proxy['observed_5xx_pct']
    signal('代理请求错误率', 'unknown' if rate is None else 'bad' if proxy['access_records'] >= 20 and rate >= 10 else 'ok', **proxy)

oom = command('journalctl', '--quiet', '--no-pager', '-k', '--since=-5min', '-n', '1500', '-o', 'cat')
oom_count = len(re.findall(r'Out of memory: Killed process|oom-kill:', oom or '', re.I))
signal('内核 OOM', 'bad' if oom_count else 'ok' if oom is not None and visible else 'unknown', observations=oom_count, window_seconds=300)
units = command('systemctl','list-units','--failed','--no-legend','--no-pager','--plain')
signal('失败单元', 'unknown' if units is None else 'bad' if units.strip() else 'ok', count=len((units or '').splitlines()), units=[r.split()[0] for r in (units or '').splitlines()[:12] if r.split() and re.fullmatch(r'[a-zA-Z0-9_.@-]+',r.split()[0])])
print(json.dumps({'identity':identity,'signals':result}))
