"""Install the per-user SSH tunnel and import this dedicated instance's session."""
import json
import os
import plistlib
import re
import socket
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

STATE = Path(os.environ.get('SERVER_OPS_STATE', Path.home() / 'Library/Application Support/server-ops-agent'))
LABEL = 'local.server-ops-agent.nightwarden-tunnel'
PORT = 18791
SSH = ['/usr/bin/ssh', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
       '-oUpdateHostKeys=no', '-oForwardAgent=no', '-oConnectTimeout=8',
       '-oControlMaster=no', '-oControlPath=none']
BASE = f'http://127.0.0.1:{PORT}'


def private_write(target, data):
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as f:
        temp = Path(f.name)
        try:
            os.fchmod(f.fileno(), 0o600)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    os.replace(temp, target)


def main():
    os.umask(0o077)
    with sqlite3.connect((STATE/'ledger.sqlite').as_uri()+'?mode=ro', uri=True) as db:
        row = db.execute('SELECT h.alias,i.machine FROM workbench_hosts h JOIN identities i ON h.id=i.host WHERE h.id=?', ('example-host',)).fetchone()
    if not row or not re.fullmatch(r'[a-zA-Z0-9][\w.-]{0,63}', row[0]):
        raise SystemExit('缺少已核实的 VPS 主机登记')
    alias, identity = row
    if not re.fullmatch(r'[a-f0-9]{64}', identity):
        raise SystemExit('主机摘要无效')
    # Read the dedicated DSH session only after checking the enrolled host identity.
    remote = """python3 -I - """
    probe = """import hashlib, pathlib, sys
if hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes().strip()).hexdigest()!=sys.argv[1]: sys.exit(21)
p=pathlib.Path('/opt/dsh-nightwarden/private/nightwarden.json')
if p.is_symlink() or p.stat().st_mode & 0o077: sys.exit(22)
sys.stdout.buffer.write(p.read_bytes())
"""
    result = subprocess.run(SSH+['-oClearAllForwardings=yes','-T','--',alias,remote+identity],
                            input=probe.encode(),stdout=subprocess.PIPE,check=True,timeout=25)
    config=json.loads(result.stdout)
    if config.get('host')!='example-host' or not config.get('instance') or not config.get('cookie') or config.get('baseUrl','').rstrip('/')!=BASE:
        raise SystemExit('远端连接配置与已登记实例不符')
    dst=STATE/'nightwarden.json'
    if dst.exists():
        old=json.loads(dst.read_bytes())
        if any(old.get(k)!=config.get(k) for k in ('host','instance','baseUrl')):
            raise SystemExit('现有配置指向另一个实例，需核对后再迁移')
    forward=['-oExitOnForwardFailure=yes','-oServerAliveInterval=20','-oServerAliveCountMax=3','-NT',
              '-L',f'127.0.0.1:{PORT}:127.0.0.1:{PORT}','--',alias]
    multiplex=SSH[:-2]+['-M','-S',str(STATE/'nightwarden-ssh.sock')]
    args=multiplex+forward
    job={'Label':LABEL,'ProgramArguments':args,'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10}
    plist=Path.home()/'Library/LaunchAgents'/(LABEL+'.plist')
    domain='gui/'+str(os.getuid())
    loaded=subprocess.run(['launchctl','print',domain+'/'+LABEL],capture_output=True).returncode==0
    if plist.exists() and plistlib.loads(plist.read_bytes())!=job:
        oldjob=plistlib.loads(plist.read_bytes())
        if oldjob!={**job,'ProgramArguments':SSH+forward}:
            raise SystemExit('已存在不同的隧道配置')
        if loaded:
            subprocess.run(['launchctl','bootout',domain+'/'+LABEL],check=True)
            loaded=False
    if not loaded:
        with socket.socket() as local:
            local.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            local.bind(('127.0.0.1', PORT))
        plist.parent.mkdir(parents=True,exist_ok=True)
        private_write(plist,plistlib.dumps(job))
        subprocess.run(['launchctl','bootstrap',domain,str(plist)],check=True)
    # Never send credentials to an unverified process listening on the local port.
    for _ in range(15):
        state=subprocess.run(['launchctl','print',domain+'/'+LABEL],text=True,capture_output=True).stdout
        match=re.search(r'^\s*pid = (\d+)\s*$',state,re.M)
        if match:
            ports=subprocess.run(['/usr/sbin/lsof','-nP','-a','-p',match[1],'-iTCP:'+str(PORT),'-sTCP:LISTEN'],capture_output=True,text=True)
            if f'127.0.0.1:{PORT} (LISTEN)' in ports.stdout:
                try:
                    with urlopen(BASE+'/health',timeout=4) as response:
                        if json.load(response).get('status')=='ok': break
                except OSError:
                    pass
        time.sleep(1)
    else:
        raise SystemExit('隧道尚未通过本机端口归属和服务健康检查')
    private_write(dst,json.dumps({k:config[k] for k in ('host','instance','baseUrl','cookie')}).encode())
    print('example-host 值班隧道与专属连接配置已就绪')


if __name__=='__main__':
    main()
