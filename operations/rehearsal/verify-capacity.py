"""Run on the bound VPS after installing the evidence collector. Sends one read-only acceptance alert."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path('/opt/dsh-nightwarden')
DIR = ROOT/'metrics'
PROOF = DIR/'capacity-proof.json'
CLOSURE = DIR/'capacity-closure.json'
DUTY = Path('/var/lib/dsh-nightwarden-rehearsal')
MOUNT = '/srv/appnode'
FLOOR = 5 * 1024**3
API = 'http://127.0.0.1:18791/api'
CONTAINERS = ('dsh-nightwarden','dsh-nightwarden-metrics')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')


def request(route, body=None, sender=False):
    headers={'Accept':'application/json'}
    if sender:
        env=(DUTY/'duty.env').read_text().splitlines()
        token=next(v.split('=',1)[1] for v in env if v.startswith('NW_ALERT_TOKEN='))
        headers['Authorization']='Bearer '+token
    else:
        headers['Cookie']=json.loads((ROOT/'private/nightwarden.json').read_text())['cookie']
    if body is not None:
        headers['Content-Type']='application/json'
    req=urllib.request.Request(API+route,headers=headers,data=json.dumps(body).encode() if body is not None else None)
    with opener.open(req,timeout=8) as res:
        return json.load(res)


def write(proof, target=PROOF):
    new=target.with_suffix('.tmp')
    with new.open('w') as f:
        os.fchmod(f.fileno(),0o600)
        json.dump(proof,f,indent=2,ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    new.replace(target)


def disk():
    v=os.statvfs(MOUNT)
    used=v.f_blocks-v.f_bfree
    return {'mountpoint':MOUNT,'device':str(os.stat(MOUNT).st_dev),'availableBytes':v.f_bavail*v.f_frsize,
            'filesystemBytes':v.f_blocks*v.f_frsize,'usedPercent':100*used/(used+v.f_bavail),'observedAt':stamp()}


def same_firing(proof, detail):
    if detail.get('sessionId')!=proof['sessionId']:
        raise RuntimeError('Wrong capacity investigation')
    for entry in detail['alerts']:
        alert=entry['alert']
        labels=alert['labels']
        if (alert.get('sourceAlertId')==proof['eventId'] and labels.get('dsh_event_id')==proof['eventId'] and labels.get('instance')=='example-host' and
                labels.get('mountpoint')==MOUNT and labels.get('validation')=='read_only_capacity' and
                labels.get('alertname')=='DSHReadOnlyAcceptanceFilesystemAvailableBelow5GiB' and
                datetime.datetime.fromisoformat(alert['firedAt'].replace('Z','+00:00'))==
                datetime.datetime.fromisoformat(proof['created'])):
            return entry
    raise RuntimeError('Registered firing no longer matches the original alert')


def reconcile_closure(proof, state, observation, read_session, send, save):
    """Never starts a firing. The fixed fingerprint plus startsAt addresses the original condition."""
    if state.get('status')=='verified':
        return
    if (not proof.get('final') or proof.get('readOnlyAcceptanceThresholdBytes')!=FLOOR or
            proof['firstObservation'].get('mountpoint')!=MOUNT or
            re.fullmatch(r'capacity-acceptance-[0-9a-f-]{36}',proof.get('eventId','')) is None or
            str(uuid.UUID(proof['sessionId']))!=proof['sessionId']):
        raise RuntimeError('Invalid dedicated acceptance registration')
    if state and (state.get('eventId'),state.get('sessionId'))!=(proof['eventId'],proof['sessionId']):
        raise RuntimeError('Closure receipt belongs to a different acceptance')
    if observation['device']!=proof['firstObservation']['device']:
        raise RuntimeError('Mount device changed; existing firing cannot be cleared from this observation')
    state.update(eventId=proof['eventId'],sessionId=proof['sessionId'],thresholdBytes=FLOOR)
    qualifies=observation['availableBytes']>=FLOOR
    if not qualifies and not state.get('attempts'):
        if state.get('status')!='waiting_for_capacity':
            state.update(status='waiting_for_capacity',observation=observation)
            save(state)
        return
    original=same_firing(proof,read_session())
    if not original['clearedAt'] and qualifies:
        labels=original['alert']['labels']
        alert={'status':'resolved','fingerprint':proof['eventId'],'startsAt':original['alert']['firedAt'],
               'endsAt':observation['observedAt'],'labels':labels,
               'annotations':{'summary':'只读容量验收已观测到可用空间恢复至 5 GiB 或以上。'}}
        state.update(status='checking_receipt',attempts=state.get('attempts',0)+1,observation=observation)
        save(state)
        result=send({'version':'4','status':'resolved','groupKey':proof['eventId'],
                     'groupLabels':labels,'alerts':[alert]})
        if result!={'received':0,'stored':0,'skipped':0}:
            raise RuntimeError('Unexpected receipt for a clear-only delivery')
        state['deliveryReceipt']=result
        save(state)
        original=same_firing(proof,read_session())
    if original['clearedAt']:
        state.update(status='verified',clearedAt=original['clearedAt'],verifiedAt=stamp())
        save(state)


def closure(check_only):
    if not PROOF.exists():
        if check_only: print(json.dumps({'status':'no_registered_acceptance'}))
        return
    proof=json.loads(PROOF.read_text())
    if not proof.get('final'):
        if check_only: print(json.dumps({'status':'investigation_in_progress','eventId':proof['eventId']}))
        return
    with (DIR/'capacity-closure.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        state=json.loads(CLOSURE.read_text()) if CLOSURE.exists() else {}
        if check_only:
            print(json.dumps({'registeredEvent':proof['eventId'],'sessionId':proof['sessionId'],
                              'currentObservation':disk(),'closure':state},ensure_ascii=False))
        elif state.get('status')!='verified' and time.time()>=state.get('retryAt',0):
            def save(s): write(s,CLOSURE)
            try:
                reconcile_closure(proof,state,disk(),lambda:request('/sessions/'+proof['sessionId']),
                                  lambda body:request('/alerts/ingest',body,sender=True),save)
            except (OSError,ValueError,RuntimeError) as error:
                state.update(eventId=proof['eventId'],sessionId=proof['sessionId'],
                             retryAt=int(time.time())+300,lastError=type(error).__name__)
                save(state)
                raise


def host_cpu():
    values=list(map(int,Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
    return sum(values),values[3]+values[4]


def resource_sample():
    start=stamp()
    total,idle=host_cpu()
    rows=[json.loads(line) for line in subprocess.check_output(
        ['docker','stats','--no-stream','--format','{{json .}}',*CONTAINERS],text=True,timeout=12).splitlines()]
    total2,idle2=host_cpu()
    stats={row['Name']:{'cpuPercent':float(row['CPUPerc'].strip('%')),
        'reportedMemory':row['MemUsage'],'blockIO':row['BlockIO']} for row in rows}
    root=os.statvfs('/')
    mem=next(line for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
    def allocated(p):
        return int(subprocess.check_output(['du','-s','-B1',str(p)],timeout=6).split()[0])
    return {'fromUtc':start,'toUtc':stamp(),'containers':stats,
            'hostCPUPercent':round(100*(1-(idle2-idle)/(total2-total)),2) if total2>total else None,
            'hostMemoryAvailableBytes':int(mem.split()[1])*1024,'rootAvailableBytes':root.f_bavail*root.f_frsize,
            'nightwardenStateAllocatedBytes':allocated(ROOT/'state'),'metricsStateAllocatedBytes':allocated(DIR/'storage')}


def directory_snapshot():
    d=json.loads((DIR/'directories.json').read_text())
    return {'status':d['status'],'completedAt':d.get('completed'),'rows':[
        {k:v[k] for k in ('path','device','inode','points')} for v in d['rows'].values()]}


def investigation(event):
    # Alertmanager may redeliver the same firing. Its stable ID and start bind the original investigation.
    for row in request('/sessions?kind=investigation&limit=50')['rows']:
        detail=request('/sessions/'+row['sessionId'])
        if any(a['alert']['labels'].get('dsh_event_id')==event for a in detail['alerts']):
            return row['sessionId']
    return None


def usage(session, since, stop):
    parse=lambda t:datetime.datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()
    begin,end=int(parse(since)*1000),round(parse(stop)*1000)
    args=['docker','logs','--since',str(begin//1000),'--until',str(end//1000+1),'dsh-nightwarden']
    logs=subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL)
    totals={}
    for line in logs.splitlines():
        try: row=json.loads(line)
        except ValueError: continue
        if row.get('msg')!='LLM usage' or not begin<=row.get('time',0)<=end:
            continue
        model=row.get('model','')
        if not re.fullmatch('[a-zA-Z0-9._:/-]+',model): model='unidentified'
        g=totals.setdefault(model,{'calls':0,'counters':{}})
        g['calls']+=1
        for k in ['input','output','cacheRead','cacheWrite']:
            if isinstance(row.get(k),int):
                counter=g['counters'].setdefault(k,{'total':0,'samples':0})
                counter['total']+=row[k];counter['samples']+=1
    overlapping={r['sessionId'] for kind in ['investigation','chat']
        for r in request('/sessions?limit=200&kind='+kind)['rows'] if r['sessionId']!=session and
        parse(r['createdAt'])<=parse(stop) and parse(r['lastActivityAt'])>=parse(since)}
    return {'fromUtc':since,'throughUtc':stop,'otherPossiblyOverlappingSessions':len(overlapping),
            'attribution':'instance log time window; LLM usage records do not carry session ID','byModel':totals}


def run():
    os.umask(0o077)
    if len(sys.argv)!=2 or hashlib.sha256(Path('/etc/machine-id').read_bytes().strip()).hexdigest()!=sys.argv[1]:
        raise RuntimeError('Host differs from enrolled machine')
    if (ROOT/'deployment-id').read_text()!='dsh-nightwarden\n':
        raise RuntimeError('Dedicated state directory unavailable')
    if PROOF.exists():
        proof=json.loads(PROOF.read_text())
        if proof.get('final'):
            return
    else:
        d=disk()
        if d['availableBytes']>=FLOOR:
            raise RuntimeError('Real available capacity does not satisfy this acceptance threshold')
        with sqlite3.connect((DUTY/'duty.sqlite').as_uri()+'?mode=ro',uri=True) as db:
            if db.execute('SELECT 1 FROM duty_capacity_active').fetchone():
                raise RuntimeError('A duty capacity event already exists; review it before opening an acceptance alert')
        proof={'eventId':'capacity-acceptance-'+str(uuid.uuid4()),'firstObservation':d,'created':stamp(),
               'readOnlyAcceptanceThresholdBytes':FLOOR,'normalThresholdPercent':json.loads((DUTY/'config.json').read_text()).get('capacityPct',85),
               'directorySnapshot':directory_snapshot(),'resources':[]}
        write(proof)
    event=proof['eventId']
    session=investigation(event)
    if not session and not proof.get('ingestReceipt'):
        d=disk()
        if d['availableBytes']>=FLOOR: raise RuntimeError('Threshold is no longer met')
        labels={'alertname':'DSHReadOnlyAcceptanceFilesystemAvailableBelow5GiB','instance':'example-host','mountpoint':MOUNT,
            'dsh_event_id':event,'validation':'read_only_capacity'}
        alert={'status':'firing','startsAt':proof['created'],'fingerprint':event,'labels':labels,
            'annotations':{'summary':'只读容量验收：/srv/appnode 可用空间低于 5 GiB。常规百分比阈值独立评估。',
            'description':'请通过已接入的真实 VictoriaMetrics 核对 node_filesystem_avail_bytes、node_filesystem_size_bytes、dsh_directory_allocated_bytes、dsh_directory_sample_timestamp_seconds。目录值每30秒重发，只有同一路径、设备和 inode 的两个不同采集时间才支持增长结论；可核对 dsh_directory_change_bytes 和 dsh_directory_previous_sample_timestamp_seconds。分别报告当前占用和可核实的变化，注明未知；只读取证，清理用户数据需由人决定。'}}
        proof['ingestReceipt']=request('/alerts/ingest',{'version':'4','status':'firing','groupKey':event,
            'groupLabels':labels,'alerts':[alert]},sender=True)
        write(proof)
    for _ in range(20):
        session=session or investigation(event)
        if session:break
        time.sleep(2)
    if not session:raise RuntimeError('Could not correlate investigation')
    proof['sessionId']=session;write(proof)
    for _ in range(140):
        detail=request('/sessions/'+session)
        if not detail['running']:break
        sample=resource_sample()
        sample['runningBefore']=True
        sample['runningAfter']=request('/sessions/'+session)['running']
        proof['resources'].append(sample)
        write(proof)
        time.sleep(3)
    detail=request('/sessions/'+session)
    if detail['running']:raise RuntimeError('Investigation is still active; re-run observation')
    reports=request('/sessions/'+session+'/report')
    row=next(r for r in request('/sessions?kind=investigation&limit=50')['rows'] if r['sessionId']==session)
    submitted=reports['record'].get('report')
    proof['modelEvidence']={'count':len(reports['evidence']),'decisions':len(reports['decisions']),
        'tools':sorted({t['toolName'] for t in detail['transcript'] if t['kind']=='tool_call'}),
        'queries':[e['input'].get('query') for e in reports['evidence'] if e['toolName'] in ('QueryMetrics','QueryMetricsRange')],
        'report':{k:submitted[k] for k in ('headline','affected','summary','impact','recommendation','submittedAt')} if submitted else None}
    proof['final']={'capturedAt':stamp(),'status':row['status'],'alertCleared':any(
        a['clearedAt'] is not None for a in detail['alerts'] if a['alert']['labels'].get('dsh_event_id')==event),
        'sentResolved':False,'endCapacity':disk(),'directories':directory_snapshot()}
    proof['modelUsage']=usage(session,detail['createdAt'],detail['lastActivityAt'])
    write(proof)


if __name__=='__main__':
    os.umask(0o077)
    if sys.argv[1:] in (['close-if-recovered'],['closure-status']):
        closure(sys.argv[1]=='closure-status')
    else:
        run()
