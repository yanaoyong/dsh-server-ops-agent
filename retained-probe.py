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
