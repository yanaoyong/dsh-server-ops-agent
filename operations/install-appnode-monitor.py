"""Install or update the minute sampler on the identity enrolled as example-host."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import tempfile

STORE = Path('/var/lib/dsh-appnode-monitor')
UNIT = """[Unit]
Description=DSH read-only appnode business checks
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I /var/lib/dsh-appnode-monitor/monitor.py
TimeoutStartSec=55
Nice=10
UMask=0077
"""
TIMER = """[Unit]
Description=Sample appnode business endpoints every minute

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=1s

[Install]
WantedBy=timers.target
"""


def install(machine, source):
    if hashlib.sha256(Path('/etc/machine-id').read_bytes().strip()).hexdigest() != machine:
        raise ValueError('主机身份与登记记录不一致')
    STORE.mkdir(mode=0o700, exist_ok=True)
    if STORE.is_symlink() or STORE.stat().st_uid != 0 or STORE.stat().st_mode & 0o077:
        raise ValueError('采样目录须归宿主机管理员专用')
    units = Path('/etc/systemd/system')
    for target, data, mode in [(STORE/'monitor.py',source,0o600),
                               (units/'dsh-appnode-monitor.service',UNIT,0o644),
                               (units/'dsh-appnode-monitor.timer',TIMER,0o644)]:
        with tempfile.NamedTemporaryFile(mode='w',dir=target.parent,delete=False) as temp:
            temp.write(data)
            os.fchmod(temp.fileno(), mode)
        Path(temp.name).replace(target)
    for args in [('daemon-reload',),('enable','--now','dsh-appnode-monitor.timer'),('start','dsh-appnode-monitor.service')]:
        subprocess.run(['systemctl',*args],check=True)


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--remote':
        install(sys.argv[2],sys.argv[3])
    else:
        ledger=Path(os.environ.get('SERVER_OPS_STATE', Path.home() / 'Library/Application Support/server-ops-agent')) / 'ledger.sqlite'
        with sqlite3.connect(ledger.as_uri()+'?mode=ro',uri=True) as db:
            host=db.execute("""SELECT h.alias,i.machine,v.body FROM workbench_hosts h JOIN enrolled e ON e.host=h.id
                            JOIN identities i ON i.host=h.id JOIN inventories v ON v.host=h.id WHERE h.id='example-host'""").fetchone()
        if not host or not any(c['name']=='appnode' and c.get('observed') for c in json.loads(host[2])['containers']):
            sys.exit('未登记 appnode')
        code=Path(__file__).with_name('appnode-monitor.py').read_text()
        subprocess.run(['ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=8',
                        '-oForwardAgent=no','-oClearAllForwardings=yes','-T','--',host[0],
                        shlex.join(['python3','-I','-','--remote',host[1],code])],
                       input=Path(__file__).read_text(),text=True,check=True)
