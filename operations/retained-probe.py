# Runs after log-evidence.py on the enrolled Linux host.
import base64
import hashlib
import os
import time
import sys

request = json.loads(base64.b64decode(sys.argv[1]))
identity = hashlib.sha256(open('/etc/machine-id', 'rb').read().strip()).hexdigest()
if identity != request['machine']:
    sys.exit(2)
if request['task'] == 'journal':
    start, end = request['start'], request['end']
    if not (0 <= start < end <= int(time.time()) and end - start <= 1800 and start % 60 == end % 60 == 0):
        sys.exit(3)
    lines, full = journal_lines(start, end, 4000)
    facts = ssh_failures(lines, start, end, full)
    # A silent or rotated interval cannot establish historical service availability.
    stamps = set()
    if facts['window_complete'] and (os.geteuid() == 0 or set(os.getgroups()).intersection(
            g.gr_gid for g in __import__('grp').getgrall() if g.gr_name in ('adm','systemd-journal'))):
        for line in lines:
            stamp = int(json.loads(line)['__REALTIME_TIMESTAMP']) // 60000000 * 60
            if start <= stamp < end:
                stamps.add(stamp)
    print(json.dumps({'minutes': [[t, facts['minute_failures'][(t-start)//60]] for t in sorted(stamps)],
                      'complete': facts['window_complete']}))
elif request['task'] == 'directory':
    source = request['source']
    if not os.path.isabs(source) or source == '/' or os.path.realpath(source) != source or not os.path.isdir(source):
        sys.exit(4)
    seconds = request.get('seconds', 75)
    if type(seconds) is not int or seconds not in (75, 180):
        sys.exit(4)
    p = subprocess.run(['timeout','--kill-after=2s',str(seconds)+'s','ionice','-c3','nice','-n','19','du','-sx','-B1','--',source],
                       capture_output=True,timeout=seconds+5)
    print(json.dumps({'bytes': int(p.stdout.split()[0]) if p.returncode == 0 else None,
                      'reason': 'timeout' if p.returncode in (124,137) else 'unavailable' if p.returncode else None}))
elif request['task'] == 'appnode':
    import sqlite3
    with sqlite3.connect('file:/var/lib/dsh-appnode-monitor/samples.sqlite?mode=ro', uri=True) as db:
        rows = db.execute('SELECT t,data FROM minutes WHERE t>? ORDER BY t LIMIT 180', (request['after'],))
        print(json.dumps([[t,json.loads(data)] for t,data in rows]))
elif request['task'] == 'daily-output':
    import datetime
    date = datetime.date.fromisoformat(request['date']).strftime('%Y%m%d')
    if not re.fullmatch(r'[0-9]{8}', date):
        sys.exit(5)
    # Date is validated; only fixed paths and local tracking refs are inspected.
    def run(*args):
        return subprocess.run(['docker','exec','-u','appuser','appnode',*args],capture_output=True,timeout=5)
    parent = '/workspace/daily-output/artifacts/'
    if run('test','-d',parent).returncode:
        sys.exit(6)
    head = run('git','-C','/workspace/daily-output','rev-parse','HEAD')
    upstream = run('git','-C','/workspace/daily-output','rev-parse','@{upstream}')
    print(json.dumps({'output':run('test','-d',parent+'output-'+date).returncode==0,
                      'backup':run('test','-d',parent+'backup-'+date).returncode==0,
                      'tracking':head.stdout==upstream.stdout if head.returncode==upstream.returncode==0 else None}))
