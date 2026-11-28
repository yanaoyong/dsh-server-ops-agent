"""Install the Mac pilot in an account-private runtime directory."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

LABEL = 'local.server-ops-agent.pilot'
HOME = Path.home()
DATA = HOME/'Library/Application Support/server-ops-agent'
PLIST = HOME/'Library/LaunchAgents'/f'{LABEL}.plist'
DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
SRC = Path(__file__).resolve().parent
DOMAIN = f'gui/{os.getuid()}'


def call(*args, check=True):
    return subprocess.run(args, check=check).returncode


def profile(name, template):
    if not (HOME/'.dsh/profiles'/name/'package.json').exists():
        # --help is forwarded after creating the profile from the shipped template.
        call(DSH, '--profile', name, '--from-default-profile', template, '--help')


def copy_runtime(runtime):
    for f in SRC.iterdir():
        if f.is_file() and (f.suffix in ('.js','.mjs') or f.name in ('supervise.py','linux-probe.py','retained-probe.py','log-evidence.py', 'check-edge.py','cordis.patch.yml','package.json')):
            shutil.copy2(f,runtime/f.name)
    shutil.copytree(SRC/'generated', runtime/'generated', dirs_exist_ok=True)
    (runtime/'legacy-local').touch()


def main():
    os.umask(0o077)
    if len(sys.argv) != 2 or sys.argv[1] not in ('install','install-desktop','stop','start'):
        sys.exit('usage: install.py install|install-desktop|start|stop')
    if sys.argv[1] == 'stop':
        if subprocess.run(['launchctl','print',DOMAIN+'/'+LABEL],capture_output=True).returncode == 0:
            call('launchctl','bootout',DOMAIN+'/'+LABEL)
        PLIST.unlink(missing_ok=True)
        return
    if sys.argv[1] == 'start' and PLIST.exists():
        if subprocess.run(['launchctl','print',DOMAIN+'/'+LABEL],capture_output=True).returncode:
            call('launchctl','bootstrap',DOMAIN,str(PLIST))
        return
    node = shutil.which('node')
    if not node:
        sys.exit('需要 Node.js >=22.13')
    call(node,'--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';new DatabaseSync(':memory:')")
    DATA.mkdir(parents=True,mode=0o700,exist_ok=True)
    runtime = DATA/'runtime'
    runtime.mkdir(exist_ok=True)
    copy_runtime(runtime)
    profile('server-ops-model','headless')
    profile('server-ops-dev','web')
    call(DSH,'plugin','--profile','server-ops-dev','add','link:'+str(runtime),'--offline')
    if sys.argv[1] == 'install-desktop':
        call(DSH,'plugin','--profile','desktop','add','link:'+str(runtime),'--offline')
    call(node,str(runtime/'control.js'),'init')
    conf = dict(Label=LABEL,ProgramArguments=[sys.executable,str(runtime/'supervise.py'),node],
                RunAtLoad=True,KeepAlive=True,ThrottleInterval=10,ProcessType='Background',
                EnvironmentVariables={'PATH':str(Path(node).parent)+':/usr/local/bin:/usr/bin:/bin'},
                StandardOutPath=str(DATA/'pilot.log'),StandardErrorPath=str(DATA/'pilot-errors.log'))
    PLIST.parent.mkdir(exist_ok=True)
    identical = PLIST.exists() and plistlib.loads(PLIST.read_bytes()) == conf
    PLIST.write_bytes(plistlib.dumps(conf))
    running = subprocess.run(['launchctl','print',DOMAIN+'/'+LABEL],capture_output=True).returncode == 0
    if running and identical:
        call('launchctl','kickstart','-k',DOMAIN+'/'+LABEL)
    else:
        if running:
            call('launchctl','bootout',DOMAIN+'/'+LABEL)
        for attempt in range(6):
            if not call('launchctl','bootstrap',DOMAIN,str(PLIST),check=False):
                break
            time.sleep(1)
        else:
            sys.exit('launchctl bootstrap 未完成')
    print('Pilot installed:', PLIST)


if __name__=='__main__':
    main()
