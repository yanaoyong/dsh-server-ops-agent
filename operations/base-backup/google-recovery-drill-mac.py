"""Run the off-host drill using the Mac key and a temporary loopback-only SSH relay."""
import argparse
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import subprocess
import sys
import time

SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12',
       '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=5']
# A .check file appears only after backup exited successfully with its snapshot ID.
# The off-host restore can then run alongside the server's full pack readback.
CHECKPOINT = """python3 -I -c 'import json, pathlib
root=pathlib.Path("/var/lib/dsh-google-server")
for check in sorted(root.glob("*.check"), reverse=True):
    path=check.with_suffix(".jsonl")
    with path.open("rb") as f:
        f.seek(max(0,path.stat().st_size-65536))
        lines=f.read().splitlines()
    for line in reversed(lines):
        try: row=json.loads(line)
        except ValueError: continue
        if row.get("message_type")=="summary" and row.get("snapshot_id"):
            print(check.stem,row["snapshot_id"]);raise SystemExit(0)
'"""
REMOTE = 'dsh-google:server-recovery/restic-v1'
KEY = Path.home() / 'Library/Application Support/server-ops-agent/disaster-recovery/example-host-backup.key'


def local_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


@contextlib.contextmanager
def relay(host, container):
    port = local_port()
    rport = int(subprocess.check_output(SSH + [host, """python3 -c 'import socket
with socket.socket() as s:
 s.bind(("127.0.0.1",0));print(s.getsockname()[1])'"""]))
    password = secrets.token_urlsafe(32)
    digest = base64.b64encode(hashlib.sha1(password.encode()).digest()).decode()
    # Only the one-time verifier reaches the SSH host. The Drive credentials stay there.
    remote = '''
set -eu
umask 077
file=$(mktemp /run/dsh-drill-auth.XXXXXX)
trap 'rm -f "$file"' EXIT
head -n 1 > "$file"
export RCLONE_CONFIG=/var/lib/dsh-workspace-private/google-drive.conf
rclone serve restic --append-only --htpasswd "$file" --addr 127.0.0.1:PORT REMOTE &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -f "$file"' EXIT
# The relay closes when its SSH client closes stdin.
cat >/dev/null
'''.replace('PORT', str(rport)).replace('REMOTE', shlex.quote(REMOTE))
    connection = subprocess.Popen(SSH + ['-T', '-o', 'ExitOnForwardFailure=yes', '-L',
                                  f'127.0.0.1:{port}:127.0.0.1:{rport}', host, remote],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
    try:
        connection.stdin.write(f'drill:{{SHA}}{digest}\n'.encode())
        connection.stdin.flush()
        execute = ['docker', 'exec', '-i', container]
        for path, value in (('repository', f'rest:http://drill:{password}@host.docker.internal:{port}/\n'.encode()),
                            ('recovery.key', KEY.read_bytes())):
            subprocess.run(execute + ['sh', '-c', f'umask 077; cat > /dev/shm/dsh-{path}'],
                           input=value, check=True)
        command = ['docker', 'exec', '-e', 'RESTIC_REPOSITORY_FILE=/dev/shm/dsh-repository',
                   '-e', 'RESTIC_PASSWORD_FILE=/dev/shm/dsh-recovery.key', container]
        for _ in range(20):
            if connection.poll() is not None:
                raise RuntimeError('SSH relay exited')
            # Preflight against the actual repository using the off-host key.
            p = subprocess.run(command + ['restic', '--no-lock', 'cat', 'config'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            if p.returncode == 0:
                break
            time.sleep(2)
        else:
            raise RuntimeError('Google repository read through SSH relay failed')
        yield command
    finally:
        connection.stdin.close()
        try:
            connection.wait(timeout=10)
        except subprocess.TimeoutExpired:
            connection.terminate()
            connection.wait(timeout=10)
        subprocess.run(['docker', 'exec', container, 'rm', '-f', '/dev/shm/dsh-repository',
                        '/dev/shm/dsh-recovery.key'], stdout=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('container')
    parser.add_argument('--host', default='example-ops-ssh')
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--since', default='00000000T000000Z')
    args = parser.parse_args()
    os.umask(0o077)
    if args.probe:
        with relay(args.host, args.container):
            print('Restic repository opened from isolated Linux with independent Mac key')
        return
    if not re.fullmatch(r'\d{8}T\d{6}Z', args.since):
        raise ValueError('invalid minimum backup timestamp')
    while True:
        try:
            state = subprocess.run(SSH + [args.host, CHECKPOINT],
                                   stdout=subprocess.PIPE, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            time.sleep(90)
            continue
        fields = state.stdout.split()
        if (state.returncode == 0 and len(fields) == 2 and fields[0] >= args.since
                and re.fullmatch('[0-9a-f]{8,64}', fields[1])):
            break
        time.sleep(90)
    snapshot = fields[1]
    subprocess.run(['docker', 'start', args.container], check=True, stdout=subprocess.DEVNULL)
    print('Starting isolated Google restore of', snapshot, flush=True)
    with relay(args.host, args.container) as command:
        dest = f'/drill/{snapshot}-{int(time.time())}'
        subprocess.run(command + ['unshare', '--mount', '--propagation', 'private',
                       'python3', '/usr/local/libexec/dsh-rehearse-google-server.py', snapshot, dest], check=True)
        evidence = subprocess.check_output(command + ['cat', dest + '/result.json'])
    report = json.loads(evidence)
    if report.get('snapshot') != snapshot or not report.get('boot_and_services_passed'):
        raise RuntimeError('drill did not pass')
    output = KEY.parent / f'google-server-{snapshot}-boot.json'
    output.write_bytes(evidence)
    cloud = 'dsh-google:server-recovery/drills/' + snapshot + '-' + str(report['finished']) + '.json'
    publish = '''
set -eu
umask 077
t=$(mktemp)
trap 'rm -f "$t"' EXIT
cat > "$t"
export RCLONE_CONFIG=/var/lib/dsh-workspace-private/google-drive.conf
rclone copyto --immutable --checksum "$t" CLOUD
rclone cat CLOUD | cmp - "$t"
'''.replace('CLOUD', shlex.quote(cloud))
    subprocess.run(SSH + [args.host, publish], input=evidence, check=True)
    print('Completed independent recovery rehearsal', snapshot)


if __name__ == '__main__':
    main()
