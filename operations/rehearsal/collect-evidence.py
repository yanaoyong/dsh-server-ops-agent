"""Collect only fixed host metrics and first-level directory allocation for the VPS rehearsal."""
import base64
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT = Path('/opt/dsh-nightwarden/metrics')
MOUNT = Path('/srv/appnode')
VM = 'http://127.0.0.1:18863'
MOUNT_ID = ROOT / 'capacity-mount-uuid'


def registered_mount():
    if not MOUNT.is_mount():
        return False
    if not MOUNT_ID.exists():
        return True
    result = subprocess.run(['findmnt', '-n', '-o', 'UUID', '-M', str(MOUNT)], capture_output=True, text=True, timeout=3)
    return result.returncode == 0 and result.stdout.strip() == MOUNT_ID.read_text().strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def private_json(path, payload):
    temp = path.with_suffix('.new')
    with temp.open('w') as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(payload, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def shape():
    return {str(p): (stat.st_dev, stat.st_ino)
            for p in MOUNT.iterdir() if not p.is_symlink() and p.is_dir()
            and (stat := p.stat()).st_dev == MOUNT.stat().st_dev}


def scan():
    path = ROOT / 'directories.json'
    with (ROOT / 'scan.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now = int(time.time())
        data = json.loads(path.read_text()) if path.exists() else {'attempt': 0, 'rows': {}}
        if now - data['attempt'] < 3600:
            return
        data.update(attempt=now, status='incomplete')
        private_json(path, data)
        try:
            if not registered_mount():
                raise OSError('registered mount unavailable')
            before = shape()
            # Count allocated blocks per directory entry, consistently including hard links.
            child = subprocess.run(['timeout', '--kill-after=2s', '180s', 'ionice', '-c3', 'nice', '-n', '19',
                                    'du', '-x', '--count-links', '--max-depth=1', '-B1', '--null', '--', str(MOUNT)],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=185)
            if child.returncode:
                data['status'] = 'timeout' if child.returncode in (124, 137) else 'unavailable'
            else:
                after = shape()
                rows = {}
                for line in child.stdout.split(b'\0'):
                    if not line:
                        continue
                    value, raw_path = line.split(b'\t', 1)
                    directory = os.fsdecode(raw_path)
                    if directory not in before or before[directory] != after.get(directory):
                        continue
                    dev, ino = before[directory]
                    key = f'{dev}:{ino}:{directory}'
                    prior = data['rows'].get(key, {}).get('points', [])[-1:]
                    rows[key] = {'path': directory, 'device': str(dev), 'inode': str(ino),
                                 'points': prior + [[now, int(value)]]}
                data.update(rows=rows, status='ok', completed=int(time.time()))
        except (OSError, ValueError, subprocess.TimeoutExpired):
            data['status'] = 'unavailable'
        private_json(path, data)


def label(s):
    return str(s).replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')


def metrics():
    lines = []
    def put(name, value, **labels):
        pairs = dict(instance='example-host', job='dsh-nightwarden', **labels)
        tags = ','.join(f'{k}="{label(v)}"' for k, v in pairs.items())
        lines.append(f'{name}{{{tags}}} {value}')
    put('up', 1)
    mem = Path('/proc/meminfo').read_text().splitlines()
    put('node_memory_MemAvailable_bytes', int(next(s for s in mem if s.startswith('MemAvailable:')).split()[1])*1024)
    put('node_load1', os.getloadavg()[0])
    try:
        if not registered_mount():
            raise OSError('registered mount unavailable')
        disk = os.statvfs(MOUNT)
        put('node_filesystem_avail_bytes', disk.f_bavail*disk.f_frsize, mountpoint=MOUNT, device=MOUNT.stat().st_dev)
        put('node_filesystem_size_bytes', disk.f_blocks*disk.f_frsize, mountpoint=MOUNT, device=MOUNT.stat().st_dev)
    except OSError:
        pass
    path = ROOT / 'directories.json'
    if path.exists():
        data = json.loads(path.read_text())
        put('dsh_directory_scan_last_attempt_timestamp_seconds', data['attempt'])
        put('dsh_directory_scan_success', int(data['status'] == 'ok'))
        for row in data['rows'].values():
            labels = {k: row[k] for k in ('path', 'device', 'inode')}
            points = row['points']
            at, size = points[-1]
            put('dsh_directory_allocated_bytes', size, **labels)
            put('dsh_directory_sample_timestamp_seconds', at, **labels)
            if len(points) == 2 and points[0][0] < at:
                put('dsh_directory_previous_sample_timestamp_seconds', points[0][0], **labels)
                put('dsh_directory_change_bytes', size - points[0][1], **labels)
    credentials = 'dsh-metrics:' + (ROOT/'access').read_text()
    request = urllib.request.Request(VM + '/api/v1/import/prometheus',
        data=('\n'.join(lines) + '\n').encode(), headers={'Authorization': 'Basic ' +
        base64.b64encode(credentials.encode()).decode(),'Content-Type':'text/plain'})
    with http.open(request, timeout=8) as response:
        if response.status != 204:
            raise RuntimeError('Metrics ingestion receipt missing')


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1:] == ['scan']:
        scan()
    elif sys.argv[1:] == ['sample']:
        metrics()
    else:
        sys.exit('expected sample or scan')
