"""Bind the rehearsal alert sender and fixed host metrics to its NightWarden instance."""
import argparse
import base64
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

NW = Path('/opt/dsh-nightwarden')
ROOT = NW/'metrics'
DUTY = Path('/var/lib/dsh-nightwarden-rehearsal')
ORIGIN = 'http://127.0.0.1:18791'
VM = 'http://127.0.0.1:18863'
NAME = 'dsh-nightwarden-metrics'
NETWORK = 'dsh-nightwarden-evidence'
UNIT = 'dsh-nightwarden-rehearsal.service'
IMAGE = 'docker.io/victoriametrics/victoria-metrics@sha256:a90b8f87ee91063022f34b41240de1c47ecede9de508fb00ccbd6d18b2595dd6'
LABEL = 'local.dsh.rehearsal.evidence'
SSH = ['/usr/bin/ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oUpdateHostKeys=no','-oForwardAgent=no',
       '-oClearAllForwardings=yes','-oControlMaster=no','-oControlPath=none','-oConnectTimeout=10','-T','--','example-ops-ssh']


def require(condition, label):
    if not condition:
        raise RuntimeError(label)


def cmd(*args):
    return subprocess.check_output(args, text=True).strip()


def write(path, text, mode=0o600):
    require(not path.is_symlink(), 'Refusing to overwrite a symlink')
    temp = path.with_name('.' + path.name + '-' + secrets.token_hex(8))
    try:
        with temp.open('x') as f:
            os.fchmod(f.fileno(), mode)
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def http(url, body=None, cookie=None, authorization=None):
    headers = {'Accept':'application/json'}
    if cookie:
        headers['Cookie'] = cookie
    if authorization:
        headers['Authorization'] = authorization
    if body is not None:
        headers.update({'Content-Type':'application/json','Origin':ORIGIN})
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with opener.open(req, timeout=10) as res:
        return json.load(res)


def set_alert(cookie, change):
    prefix = ORIGIN+'/api/integrations/alerting/alertmanager'
    status = http(prefix, cookie=cookie)
    require(status.get('ingestUrl') == ORIGIN+'/api/alerts/ingest','Unexpected ingestion origin')
    env_file = DUTY/'duty.env'
    raw = env_file.read_text() if env_file.exists() else ''
    token = next((v.split('=',1)[1] for v in raw.splitlines() if v.startswith('NW_ALERT_TOKEN=')), None)
    if not status['configured']:
        require(change and not token, 'Sender state conflicts with stored token')
        token = http(prefix+'/credential', {}, cookie)['token']
        require(re.fullmatch(r'nwi_[a-zA-Z0-9_-]{43}', token), 'Invalid credential response')
        write(env_file, raw.rstrip()+'\nNW_ALERT_TOKEN='+token+'\n')
    require(token and re.fullmatch(r'nwi_[a-zA-Z0-9_-]{43}',token)
            and stat.S_IMODE(env_file.stat().st_mode) == 0o600,'Existing sender requires its own private token')
    # This verifies both possession and selection of the expected source without starting a model run.
    try:
        http(status['ingestUrl'], {}, authorization='Bearer '+token)
        raise RuntimeError('Empty envelope was accepted unexpectedly')
    except urllib.error.HTTPError as e:
        require(e.code == 400,'Stored sender credential did not survive ingress authentication')
    config_file = DUTY/'config.json'
    cfg = json.loads(config_file.read_text())
    require(cfg.get('host')=='example-host' and cfg.get('container')=='dsh-nw-rehearsal' and
            cfg.get('nightwardenUrl') in (None,status['ingestUrl']),'Unexpected duty target or existing ingress')
    if cfg.get('nightwardenUrl') != status['ingestUrl']:
        require(change,'Sender URL has not been installed')
        cfg['nightwardenUrl'] = status['ingestUrl']
        write(config_file,json.dumps(cfg)+'\n')
    return status


def metrics_service():
    password = ROOT/'access'
    if not password.exists():
        write(password,secrets.token_urlsafe(32))
    require(password.is_file() and not password.is_symlink() and stat.S_IMODE(password.stat().st_mode)==0o600,
            'Metrics credential has unsafe permissions')
    data = ROOT/'storage'
    data.mkdir(mode=0o700,exist_ok=True)
    if not cmd('docker','network','ls','-q','--filter','name=^'+NETWORK+'$'):
        cmd('docker','network','create','--label',LABEL+'=1',NETWORK)
    network = json.loads(cmd('docker','network','inspect',NETWORK))[0]
    require(network['Labels'].get(LABEL)=='1','Network belongs to another project')
    if not cmd('docker','ps','-aq','--filter','name=^/'+NAME+'$'):
        cmd('docker','pull','--platform','linux/amd64',IMAGE)
        cmd('docker','run','-d','--name',NAME,'--label',LABEL+'=1','--platform','linux/amd64',
            '--network',NETWORK,'--publish','127.0.0.1:18863:8428','--restart','unless-stopped',
            '--memory','192m','--memory-swap','192m','--cpus','0.50','--user','0:0','--read-only',
            '--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,size=16m',
            '--log-opt','max-size=3m','--log-opt','max-file=2','--mount',f'type=bind,src={data},dst=/storage',
            '--mount',f'type=bind,src={password},dst=/run/dsh-pass,readonly',IMAGE,
            '-storageDataPath=/storage','-retentionPeriod=2d','-storage.minFreeDiskSpaceBytes=1GB',
            '-memory.allowedBytes=64MiB','-search.maxConcurrentRequests=2','-httpAuth.username=dsh-metrics',
            '-httpAuth.password=file:///run/dsh-pass','-enableMetadata')
    inspected = json.loads(cmd('docker','inspect',NAME))[0]
    require(inspected['Config']['Labels'].get(LABEL)=='1' and inspected['Config']['Image']==IMAGE and
            inspected['HostConfig']['PortBindings']=={'8428/tcp':[{'HostIp':'127.0.0.1','HostPort':'18863'}]},
            'Unexpected existing metrics container')
    if not inspected['State']['Running']:
        cmd('docker','start',NAME)
    nw = json.loads(cmd('docker','inspect','dsh-nightwarden'))[0]
    require(nw['Config']['Labels'].get('local.dsh.nightwarden')=='f6b78bd1eda7204eb143994b603ae6a2fa836942',
            'Unexpected NightWarden container')
    if NETWORK not in nw['NetworkSettings']['Networks']:
        cmd('docker','network','connect',NETWORK,'dsh-nightwarden')


def timers(collector):
    marker = '# DSH NightWarden fixed metrics rehearsal'
    write(ROOT/'collect.py',collector)
    for kind,spacing in [('sample','30s'),('scan','1h')]:
        unit = 'dsh-nightwarden-'+kind
        service = f"""{marker}
[Unit]
Description=NightWarden fixed host metrics {kind}
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I {ROOT}/collect.py {kind}
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={ROOT}
Nice=19
IOSchedulingClass=idle
TimeoutStartSec=210s
"""
        timer = f"""{marker}
[Unit]
Description=NightWarden {kind} schedule
[Timer]
OnBootSec=30s
OnUnitActiveSec={spacing}
AccuracySec=1s
[Install]
WantedBy=timers.target
"""
        for ext,body in [('service',service),('timer',timer)]:
            file = Path('/etc/systemd/system')/(unit+'.'+ext)
            require(not file.exists() or file.read_text().startswith(marker),'Existing systemd unit conflicts')
            write(file,body,0o644)
    cmd('systemctl','daemon-reload')
    cmd('systemctl','enable','--now','dsh-nightwarden-sample.timer','dsh-nightwarden-scan.timer')
    cmd('systemctl','start','--no-block','dsh-nightwarden-scan.service')


def install_closure(program):
    marker='# DSH NightWarden capacity acceptance closure'
    service=Path('/etc/systemd/system/dsh-nightwarden-sample.service')
    require(service.read_text().startswith('# DSH NightWarden fixed metrics rehearsal'),
            'Existing sample service belongs to another installation')
    write(ROOT/'verify-capacity.py',program)
    dropin=service.with_name(service.name+'.d')
    dropin.mkdir(mode=0o755,exist_ok=True)
    file=dropin/'capacity-closure.conf'
    require(not file.exists() or file.read_text().startswith(marker),'Unexpected sampler drop-in')
    write(file,marker+'\n[Service]\nExecStartPost=-/usr/bin/python3 -I '+str(ROOT)+'/verify-capacity.py close-if-recovered\n',0o644)
    cmd('systemctl','daemon-reload')


def serve(mode, host_hash, collector, closure_program):
    os.umask(0o077)
    require(os.geteuid()==0 and hashlib.sha256(Path('/etc/machine-id').read_bytes().strip()).hexdigest()==host_hash,
            'Host identity mismatch')
    require((NW/'deployment-id').read_text()=='dsh-nightwarden\n' and
            (DUTY/'fixture-owner').read_text()=='dsh-nw-rehearsal','Dedicated deployment marker missing')
    if not ROOT.exists():
        require(mode in ('prepare','install'),'Evidence service unavailable')
        ROOT.mkdir(mode=0o700)
        write(ROOT/'owner','dsh-evidence\n')
    require(not ROOT.is_symlink() and (ROOT/'owner').read_text()=='dsh-evidence\n','Unexpected metrics directory')
    with (ROOT/'integration.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if mode in ('closure','closure-status'):
            if mode=='closure':
                install_closure(closure_program)
                cmd('/usr/bin/python3','-I',str(ROOT/'verify-capacity.py'),'close-if-recovered')
            return json.loads(cmd('/usr/bin/python3','-I',str(ROOT/'verify-capacity.py'),'closure-status'))
        cookie=json.loads((NW/'private/nightwarden.json').read_text())['cookie']
        if mode in ('prepare','install'):
            metrics_service()
            timers(collector)
            install_closure(closure_program)
            for attempt in range(25):
                p=subprocess.run(['/usr/bin/python3','-I',str(ROOT/'collect.py'),'sample'],capture_output=True)
                if p.returncode==0: break
                time.sleep(1)
            else: raise RuntimeError('Metrics collector could not publish samples')
        vm_auth = 'Basic '+base64.b64encode(('dsh-metrics:'+(ROOT/'access').read_text()).encode()).decode()
        def query(name):
            return http(VM+'/api/v1/query?'+urllib.parse.urlencode({'query':name}),authorization=vm_auth)['data']['result']
        for attempt in range(90):
            if query('up'):break
            time.sleep(1)
        else: raise RuntimeError('Metrics backend did not return host samples')
        source_endpoint=ORIGIN+'/api/integrations/metrics'
        old=http(source_endpoint,cookie=cookie)
        url='http://'+NAME+':8428'
        if not old['configured']:
            require(mode in ('prepare','install'),'NightWarden metrics source is unconfigured')
            http(source_endpoint,{'kind':'victoriametrics','query':{'url':url,'authHeader':vm_auth}},cookie)
        else:
            require(old['kind']=='victoriametrics' and old['query']['url']==url,'An existing source already owns metrics')
        tested=http(source_endpoint+'/test',{},cookie)
        require(tested['configured'] and tested['query']['hasAuth'],'Metrics source is not authenticated')
        alert=set_alert(cookie, mode in ('prepare','install'))
        if mode=='install':
            # Restart only the isolated duty service. Leave the policy's enabled/disabled state untouched.
            with sqlite3.connect((DUTY/'duty.sqlite').as_uri()+'?mode=ro',uri=True) as db:
                require(not db.execute("select 1 from nw_policy_events where status='claimed' limit 1").fetchone(),
                        'An executor attempt is in flight')
            cmd('systemctl','restart',UNIT)
        recent = http(ORIGIN+'/api/integrations/alerting/alertmanager',cookie=cookie)['lastReceivedAt']
        with sqlite3.connect((DUTY/'duty.sqlite').as_uri()+'?mode=ro',uri=True) as db:
            attempts=db.execute("select last_status,count(*) from duty_outbox where channel='nightwarden' group by last_status").fetchall()
            deliveries=[dict(zip(('eventId','phase','attempts','sent','http'),row)) for row in db.execute(
                "SELECT event_id,json_extract(body,'$.status'),attempts,sent,last_status FROM "
                "duty_outbox WHERE channel='nightwarden' ORDER BY rowid DESC LIMIT 12")]
        event_ids={d['eventId'] for d in deliveries}
        linked=[]
        recent_sessions=http(ORIGIN+'/api/sessions?kind=investigation&limit=12',cookie=cookie)
        for row in recent_sessions['rows']:
            session_id=urllib.parse.quote(row['sessionId'],safe='')
            detail=http(ORIGIN+'/api/sessions/'+session_id,cookie=cookie)
            associated={entry['alert']['labels'].get('dsh_event_id') for entry in detail['alerts']}
            if event_ids & associated:
                linked.append({'sessionId':row['sessionId'],'status':row['status'],
                    'events':sorted(event_ids & associated),'alertCount':len(detail['alerts']),
                    'cleared':sum(a.get('clearedAt') is not None for a in detail['alerts'])})
        dirfile=ROOT/'directories.json'
        dirs=json.loads(dirfile.read_text()) if dirfile.exists() else {}
        available=query('node_filesystem_avail_bytes')
        return {'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'host':'example-host','metricsKind':tested['kind'],'metricsVersion':'v1.130.0','metricsImage':IMAGE,
                'metricsPrivatePort':'127.0.0.1:18863','remoteEndpoint':url,'metricsProbe':'passed',
                'metricsStats':json.loads(cmd('docker','stats','--no-stream','--format','{{json .}}',NAME))['MemUsage'],
                'filesystemSamples':len(available),'availableBytes': int(float(available[0]['value'][1])) if available else None,
                'firstLevelDirectories':len(dirs.get('rows',{})), 'directoryScan':dirs.get('status','not_started'),
                'directorySampleEpoch':dirs.get('completed'), 'twoPointDirectoryCount':
                    sum(len(r['points'])==2 for r in dirs.get('rows',{}).values()),
                'sourceConfigured':True,'ingestCredentialProbe':'authorized; empty envelope rejected (400)',
                'senderService':cmd('systemctl','is-active',UNIT),'sourceLastReceivedAt':recent,
                'deliveryOutcomes':dict(attempts),'recentDeliveries':deliveries,'linkedInvestigations':linked,
                'directorySamples':[{'path':r['path'],'device':r['device'],'points':r['points']} for r in dirs.get('rows',{}).values()]}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=['prepare','install','check','closure','closure-status'])
    p.add_argument('--remote',help=argparse.SUPPRESS)
    args=p.parse_args()
    if args.remote:
        print(json.dumps(serve(args.mode,args.remote,COLLECTOR_SOURCE,CLOSURE_SOURCE),indent=2))
        return
    ledger=Path(os.environ.get('SERVER_OPS_STATE', Path.home() / 'Library/Application Support/server-ops-agent')) / 'ledger.sqlite'
    with sqlite3.connect(ledger.as_uri()+'?mode=ro',uri=True) as db:
        alias,identity=db.execute("SELECT alias,machine FROM hosts JOIN identities ON host=id WHERE id='example-host'").fetchone()
    require(alias=='example-ops-ssh' and re.fullmatch('[a-f0-9]{64}',identity),'Unknown VPS binding')
    src=Path(__file__)
    remote=('COLLECTOR_SOURCE='+repr(src.with_name('collect-evidence.py').read_text())+
            '\nCLOSURE_SOURCE='+repr(src.with_name('verify-capacity.py').read_text())+'\n'+src.read_text())
    subprocess.run([*SSH,'python3 -I - '+args.mode+' --remote '+identity],input=remote,text=True,check=True)


if __name__=='__main__':
    try:main()
    except urllib.error.HTTPError as e:sys.exit('HTTP '+str(e.code)+' from dedicated service')
    except subprocess.CalledProcessError as e:sys.exit('Integration command exited with code '+str(e.returncode))
    except (OSError,RuntimeError) as e:sys.exit(str(e))
