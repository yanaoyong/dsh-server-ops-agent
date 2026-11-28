"""Install or check the isolated, loopback-only example-host NightWarden instance."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from http.cookies import SimpleCookie

IMAGE = 'ghcr.io/prabhatmattoo/nightwarden@sha256:877b69667c1232fa2d715c66436486121c92d877ee60e4d63bc1e31f6ef11e73'
IMAGE_CONFIG = 'sha256:f6ded07d433b193396c67466f793e6d670eb722733dd976df1c1b1ba7d58d63b'
COMMIT = 'f6b78bd1eda7204eb143994b603ae6a2fa836942'
NAME = 'dsh-nightwarden'
ROOT = Path('/opt/dsh-nightwarden')
STATE = ROOT / 'state'
PRIVATE = ROOT / 'private'
PORT = 18791
ORIGIN = f'http://127.0.0.1:{PORT}'
LABEL = 'local.dsh.nightwarden'
BUDGET = 512 * 1024**2
SSH = ['/usr/bin/ssh', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oUpdateHostKeys=no',
       '-oForwardAgent=no', '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPath=none',
       '-oConnectTimeout=10', '-T', '--', 'example-ops-ssh']


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def private_file(p, data):
    tmp = p.with_name('.' + p.name + '-' + secrets.token_hex(8))
    try:
        with tmp.open('x') as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    finally:
        tmp.unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def api(path, body=None, cookie=None):
    request = urllib.request.Request(ORIGIN + path, headers={'Accept': 'application/json'})
    if cookie:
        request.add_header('Cookie', cookie)
    if body is not None:
        request.data = json.dumps(body).encode()
        request.add_header('Content-Type', 'application/json')
        request.add_header('Origin', ORIGIN)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=6) as response:
        return response.headers, json.load(response)


def verify_container(info):
    ports = info['HostConfig']['PortBindings']
    mounts = {(m['Source'], m['Destination']) for m in info['Mounts']}
    require(info['Config']['Labels'].get(LABEL) == COMMIT and info['Config']['Image'] == IMAGE and
            info['Image'] in (IMAGE.split('@')[1], IMAGE_CONFIG) and
            info['HostConfig']['Memory'] == BUDGET and not info['HostConfig']['Privileged'] and
            ports == {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(PORT)}]} and
            mounts == {(str(STATE), str(STATE))}, 'Existing named container differs from managed specification')


def server(mode, expected):
    os.umask(0o077)
    machine = hashlib.sha256(Path('/etc/machine-id').read_bytes().strip()).hexdigest()
    require(secrets.compare_digest(expected, machine), 'Machine identity differs from example-host ledger')
    require(os.geteuid() == 0, 'A root account is needed for the dedicated private deployment')
    docker_root = docker('info', '--format', '{{.DockerRootDir}}')
    require(os.stat(docker_root).st_dev == os.stat('/').st_dev == os.stat('/opt').st_dev,
            'Docker or state directory would use a different filesystem from root')
    root_free = shutil.disk_usage('/').free
    exists = bool(docker('ps', '-aq', '--filter', 'name=^/' + NAME + '$'))
    info = {'identityMatched': True, 'host': 'example-host', 'rootFreeBytes': root_free,
            'rootFilesystemVerified': True, 'commit': COMMIT, 'image': IMAGE}
    if exists:
        verify_container(json.loads(docker('inspect', NAME))[0])
    else:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', PORT))
    if ROOT.exists():
        require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.stat().st_uid == 0 and
                stat.S_IMODE(ROOT.stat().st_mode) == 0o700 and
                (ROOT / 'deployment-id').read_text() == NAME + '\n', 'Conflicting state directory')
    if mode == 'preflight':
        return dict(info, existingContainer=exists)
    require(root_free >= 1024**3 or exists, 'Insufficient root filesystem space to pull image')
    if mode == 'check':
        require(exists, 'Managed container is not deployed')
    if not ROOT.exists():
        ROOT.mkdir(mode=0o700)
        (ROOT / 'deployment-id').write_text(NAME + '\n')
    with (ROOT / 'deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if mode == 'install':
            for p in (STATE, PRIVATE):
                p.mkdir(mode=0o700, exist_ok=True)
            if not docker('ps', '-aq', '--filter', 'name=^/' + NAME + '$'):
                docker('pull', '--platform', 'linux/amd64', IMAGE)
                require(docker('image', 'inspect', IMAGE, '--format', '{{.Os}}/{{.Architecture}}') ==
                        'linux/amd64', 'Unexpected image architecture')
                docker('run', '-d', '--name', NAME, '--label', LABEL + '=' + COMMIT,
                       '--platform', 'linux/amd64', '--restart', 'unless-stopped',
                       '--memory', '512m', '--memory-swap', '512m', '--log-driver', 'json-file',
                       '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
                       '--publish', f'127.0.0.1:{PORT}:3000',
                       '--mount', f'type=bind,source={STATE},target={STATE}',
                       '--env', 'NIGHTWARDEN_DIR=' + str(STATE), '--env', 'NIGHTWARDEN_PUBLIC_URL=' + ORIGIN,
                       '--health-cmd', '''node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"''',
                       '--health-interval', '30s', '--health-timeout', '5s',
                       '--health-start-period', '20s', IMAGE)
            else:
                existing = json.loads(docker('inspect', NAME))[0]
                verify_container(existing)
                if not existing['State']['Running']:
                    docker('start', NAME)
        inspected = json.loads(docker('inspect', NAME))[0]
        verify_container(inspected)
        for attempt in range(30):
            try:
                if api('/health')[1] == {'status': 'ok'}:
                    break
            except (OSError, ValueError):
                pass
            time.sleep(1)
        else:
            raise RuntimeError('NightWarden failed loopback health check')
        anon = api('/api/auth-status')[1]
        account_file = PRIVATE / 'owner.json'
        if not anon.get('ownerExists'):
            require(mode == 'install', 'No instance owner has been provisioned')
            if not account_file.exists():
                private_file(account_file, {'email': 'dsh-owner-' + secrets.token_hex(6) + '@ops.invalid',
                                            'password': secrets.token_urlsafe(42), 'name': 'DSH duty administrator'})
            credentials = json.loads(account_file.read_text())
            api('/api/auth/sign-up/email', credentials)
        require(account_file.is_file() and account_file.stat().st_mode & 0o077 == 0,
                'Expected private owner file unavailable; existing owner is left intact')
        credentials = json.loads(account_file.read_text())
        try:
            api('/api/sessions?kind=investigation&limit=1')
            raise RuntimeError('Anonymous investigation list unexpectedly readable')
        except urllib.error.HTTPError as error:
            require(error.code == 401, 'Unexpected anonymous API response')
        access = PRIVATE / 'nightwarden.json'
        previous = {}
        cookie = None
        if access.exists():
            require(stat.S_IMODE(access.stat().st_mode) == 0o600 and access.stat().st_uid == 0,
                    'DSH session file must be owned by root with mode 0600')
            previous = json.loads(access.read_text())
            cookie = previous['cookie']
        if not cookie or api('/api/auth-status', cookie=cookie)[1].get('email') != credentials['email']:
            require(mode == 'install', 'DSH login expired; install refreshes the dedicated instance session')
            headers, _ = api('/api/auth/sign-in/email', {k: credentials[k] for k in ('email', 'password')})
            cookies = SimpleCookie()
            for value in headers.get_all('Set-Cookie', []):
                cookies.load(value)
            cookie = '; '.join(f'{k}={v.coded_value}' for k, v in cookies.items())
            require(bool(cookie) and api('/api/auth-status', cookie=cookie)[1].get('email') == credentials['email'],
                    'Dedicated owner session could not be verified')
        if mode == 'install' and (cookie != previous.get('cookie') or not previous.get('instance')):
            private_file(access, {'host': 'example-host', 'instance': previous.get('instance') or secrets.token_hex(16),
                                  'baseUrl': ORIGIN, 'cookie': cookie})
        rows = api('/api/sessions?kind=investigation&limit=1', cookie=cookie)[1]
        require(isinstance(rows['rows'], list), 'Unexpected authenticated investigation page')
        stats = json.loads(docker('stats', '--no-stream', '--format', '{{json .}}', NAME))
        state_bytes = int(subprocess.check_output(['du', '-s', '-B1', str(STATE)]).split()[0])
        return dict(info, checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    container=NAME, imageID=inspected['Image'], published=f'127.0.0.1:{PORT}',
                    memoryLimitBytes=BUDGET, dockerSocketMounted=False, health='ok',
                    anonymousListStatus=401, authenticatedListStatus=200,
                    investigations=rows['investigationTotal'],
                    dockerStats=stats['MemUsage'], cpu=stats['CPUPerc'], stateAllocatedBytes=state_bytes,
                    restartPolicy=inspected['HostConfig']['RestartPolicy']['Name'],
                    dockerHealth=inspected['State']['Health']['Status'])


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('mode', choices=['preflight', 'install', 'check'])
    args.add_argument('--remote-identity', help=argparse.SUPPRESS)
    options = args.parse_args()
    if options.remote_identity:
        print(json.dumps(server(options.mode, options.remote_identity), indent=2))
        return
    db_path = Path(os.environ.get('SERVER_OPS_STATE', Path.home() / 'Library/Application Support/server-ops-agent')) / 'ledger.sqlite'
    with contextlib.closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT alias,machine FROM hosts JOIN identities ON host=id WHERE id=?',
                         ('example-host',)).fetchone()
    require(row and row[0] == 'example-ops-ssh' and re.fullmatch('[a-f0-9]{64}', row[1]),
            'Cannot verify example-host SSH binding')
    subprocess.run([*SSH, f'python3 -I - {options.mode} --remote-identity {row[1]}'],
                   input=Path(__file__).read_bytes(), check=True)


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as exc:
        sys.exit('NightWarden API returned HTTP ' + str(exc.code))
    except subprocess.CalledProcessError as exc:
        sys.exit('Deployment command exited with code ' + str(exc.returncode))
    except (OSError, RuntimeError) as exc:
        sys.exit(str(exc))
