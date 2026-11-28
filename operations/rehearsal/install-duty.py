"""Install the isolated duty fixture on the already identity-verified Linux VPS."""
from pathlib import Path
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path('/var/lib/dsh-nightwarden-rehearsal')
NAME = 'dsh-nw-rehearsal'
LABEL = 'io.dsh.nightwarden.rehearsal'
UNIT = 'dsh-nightwarden-rehearsal.service'
URL = 'http://127.0.0.1:18792/healthz'
PORT = '18792'
INTERVAL = 60


def cmd(*args, timeout=50):
    return subprocess.check_output(args, text=True, timeout=timeout).strip()


def write(path, data, mode):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as f:
        os.fchmod(f.fileno(), mode)
        f.write(data)
        temp = Path(f.name)
    temp.replace(path)


def install_decisions(node, source):
    if os.getuid() != 0 or not node.is_absolute() or not node.is_file():
        raise RuntimeError('需要固定的 Node 路径和管理员权限')
    config_path = ROOT/'config.json'
    if ROOT.is_symlink() or (ROOT/'fixture-owner').read_text() != 'dsh-nw-rehearsal':
        raise RuntimeError('人工转接需要主试点的已登记目录')
    config = json.loads(config_path.read_text())
    if (config.get('host'), config.get('container'), config.get('dbPath')) != (
            'example-host', 'dsh-nw-rehearsal', str(ROOT/'duty.sqlite')):
        raise RuntimeError('人工转接需要主试点的既有账本')
    module = ROOT/'nightwarden-decisions.js'
    write(module, (source/module.name).read_text(), 0o600)
    command = shlex.join([str(node), str(module)])
    write(ROOT/'decision-duty', f"""#!/bin/sh
set -eu
[ "$#" = 1 ] || exit 64
case "$1" in get|propose|decide) ;; *) exit 64 ;; esac
unset NODE_OPTIONS NODE_PATH
export NODE_NO_WARNINGS=1
exec {command} "$1" {shlex.quote(str(config_path))}
""", 0o700)


def install(node, source):
    if os.getuid() != 0 or not node.is_absolute() or not node.is_file():
        raise RuntimeError('需要管理员及固定的 Node 可执行文件')
    if cmd(str(node), '-p', "String(!!require('node:sqlite').DatabaseSync)") != 'true':
        raise RuntimeError('Node 需要 node:sqlite')
    marker = ROOT/'fixture-owner'
    if ROOT.exists():
        if not marker.is_file() or marker.read_text() != NAME or ROOT.is_symlink():
            raise RuntimeError('演练目录存在但未登记')
    else:
        ROOT.mkdir(mode=0o700)
        write(marker, NAME, 0o600)
    for filename in ['nightwarden-duty.js','nightwarden-policy.js','ledger.js','redact.js','paths.js','package.json']:
        write(ROOT/filename, (source/filename).read_text(), 0o600)
    flags = ROOT/'flags'
    flags.mkdir(exist_ok=True)
    flags.chmod(0o755)
    current = cmd('docker','container','ls','-a','--filter',f'name=^/{NAME}$','--format','{{.Names}}')
    config_path = ROOT/'config.json'
    registration = ROOT/'fixture.cid'
    if not current:
        if config_path.exists() or registration.exists():
            raise RuntimeError('登记容器不存在，请人工核对身份')
        image_id = cmd('docker', 'image', 'inspect', 'caddy:2-alpine', '--format', '{{.Id}}')
        # Faults live in the fixture tmpfs. A restart recreates /healthz unless the test flag is present.
        entry = ('mkdir -p /tmp/site; if [ ! -f /fixture/persist ]; then '
                 'echo fixture-healthy > /tmp/site/healthz; fi; '
                 'exec caddy file-server --root /tmp/site --listen :8080')
        cid = cmd('docker','run','-d','--name',NAME,'--label',LABEL+'=true',
                  '--read-only','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges',
                  '--user','65534:65534','--pids-limit','48','--memory','64m','--cpus','0.20',
                  '--restart','unless-stopped','--log-opt','max-size=1m','--log-opt','max-file=2',
                  '--tmpfs','/tmp:rw,noexec,nosuid,size=8m,mode=1777',
                  '--mount',f'type=bind,src={flags},dst=/fixture,readonly',
                  '--publish','127.0.0.1:'+PORT+':8080','--env','XDG_CONFIG_HOME=/tmp/config',
                  '--env','XDG_DATA_HOME=/tmp/data','--entrypoint','/bin/sh',image_id,'-ec',entry)
        write(registration,cid+'\n',0o600)
    else:
        cid = json.loads(config_path.read_text())['containerId'] if config_path.exists() else registration.read_text().strip()
    if not re.fullmatch('[a-f0-9]{64}', cid):
        raise RuntimeError('容器 ID 无效')
    info = json.loads(cmd('docker','inspect','--type','container',cid))[0]
    if not (info['Name']=='/'+NAME and info['Config']['Labels'].get(LABEL)=='true' and
            info['HostConfig']['PortBindings']=={'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':PORT}]}):
        raise RuntimeError('演练容器身份或回环端口不匹配')
    if not config_path.exists():
        deadline = time.monotonic()+12
        while time.monotonic()<deadline:
            try:
                with urllib.request.urlopen(URL,timeout=2) as response:
                    if response.read(64)==b'fixture-healthy\n': break
            except OSError: pass
            time.sleep(.25)
        else: raise RuntimeError('演练探针未就绪')
        config = {'host':'example-host','container':NAME,'containerId':cid,'probeUrl':URL,
                  'interval':INTERVAL,'dbPath':str(ROOT/'duty.sqlite')}
        write(config_path,json.dumps(config)+'\n',0o600)

    prefix = shlex.join([str(node),str(ROOT/'nightwarden-duty.js')])
    cfg = shlex.quote(str(config_path))
    if NAME == 'dsh-nw-rehearsal':
        install_decisions(node, source)
    write(ROOT/'read-duty','#!/bin/sh\nset -eu\n[ "$#" = 0 ]\nexec '+prefix+' read '+cfg+'\n',0o700)
    # Bind a browser's disable request to the currently registered immutable rule.
    write(ROOT/'disable-duty',f"""#!/usr/bin/python3 -I
import json, sys, subprocess
base={repr([str(node),str(ROOT/'nightwarden-duty.js')])}
config={str(config_path)!r}
if len(sys.argv)!=2: sys.exit('需要规则编号')
data=json.loads(subprocess.check_output([*base,'read',config],text=True))
if not data['rule'] or data['rule']['ruleId']!=sys.argv[1]: sys.exit('规则编号不匹配')
subprocess.run([*base,'disable',config],check=True)
""",0o700)
    unit_path=Path('/etc/systemd/system')/UNIT
    if unit_path.exists() and '# Managed by DSH isolated duty rehearsal' not in unit_path.read_text():
        raise RuntimeError('已有同名系统服务')
    write(unit_path,f"""# Managed by DSH isolated duty rehearsal
[Unit]
Description=DSH isolated NightWarden duty rehearsal
After=docker.service
Requires=docker.service
[Service]
Type=simple
WorkingDirectory={ROOT}
ExecStart={node} {ROOT}/nightwarden-duty.js run {config_path}
EnvironmentFile=-{ROOT}/duty.env
Environment=NODE_NO_WARNINGS=1
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths={ROOT}
MemoryMax=192M
[Install]
WantedBy=multi-user.target
""",0o644)
    cmd('systemctl','daemon-reload')
    cmd('systemctl','enable',UNIT)
    cmd('systemctl','restart',UNIT)
    print(json.dumps({'root':str(ROOT),'unit':UNIT,'container_id':cid,'image_id':info['Image'],
                      'node':cmd(str(node),'--version'),'probe':URL,'read':str(ROOT/'read-duty')}))


if __name__=='__main__':
    if sys.argv[3:] == ['--decisions-only']:
        install_decisions(Path(sys.argv[1]), Path(sys.argv[2]))
        sys.exit(0)
    if sys.argv[3:] == ['--validation']:
        ROOT = Path('/var/lib/dsh-nightwarden-rehearsal-validation')
        NAME = 'dsh-nw-validation'
        UNIT = 'dsh-nightwarden-validation.service'
        PORT = '18793'
        INTERVAL = 15
        URL = 'http://127.0.0.1:18793/healthz'
    elif sys.argv[3:]:
        sys.exit('未知安装参数')
    install(Path(sys.argv[1]),Path(sys.argv[2]))
