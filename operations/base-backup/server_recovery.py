"""Capture production data, upload encrypted archives, and verify from Baidu Netdisk."""
import concurrent.futures
import contextlib
import base64
import fcntl
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

BASE_CODE = Path(__file__).resolve().with_name('workspace.py')
KEY = Path('/var/lib/dsh-workspace-private/duplicity.key')
ROOT = Path(os.environ.get('DSH_RECOVERY_ROOT', '/data/dsh-server-recovery'))
CHUNK = 16 * 1024**2
RESERVE = 8 * 1024**3
WORKERS = 4
GROUP_BYTES = 5 * 1024**3
METRICS_VERSION = 'v1.130.0'
METRICS_ROOT = Path('/opt/dsh-nightwarden/metrics/storage')

CONTAINERS = {
    'caddy': ('example-gateway', 'example-site'),
    'appnode-config': ('appnode',),
    'base-config': ('base', 'example-site'),
    'base-essential': ('base',),
    'nightwarden': ('dsh-nightwarden', 'dsh-nightwarden-metrics'),
    'nightwarden-metrics-native': ('dsh-nightwarden-metrics',),
}
SOURCES = {
    'caddy': (
        '/opt/example-edge',
        '/var/lib/docker/volumes/example-edge_caddy_config/_data',
        '/var/lib/docker/volumes/example-edge_caddy_data/_data',
    ),
    'appnode-config': ('/opt/appnode', '/etc/systemd/system/appnode.service'),
    'appnode-essential': ('/srv/appnode/home/.local/share/example-app', '/srv/appnode/home/.openclaw/state',
                         '/srv/appnode/home/.cc-switch'),
    'appnode-workspace': ('/srv/appnode/workspace',),
    'appnode-home': ('/srv/appnode/home',),
    'appnode-tmp': ('/srv/appnode/tmp', '/srv/appnode/var-tmp'),
    'base-config': ('/data/example-workspace/workspace/.example-site',),
    'base-essential': ('/data/example-workspace/root/.local/share/example-app',),
    'base-tmp': ('/data/example-workspace/tmp',),
    'nightwarden': ('/opt/dsh-nightwarden', '/var/lib/dsh-appnode-monitor',
                    '/var/lib/dsh-nightwarden-rehearsal', '/var/lib/dsh-nightwarden-rehearsal-validation'),
    'host-config': ('/etc', '/boot', '/boot/efi', '/var/spool/cron', '/var/lib/dpkg/status',
                    '/var/lib/fail2ban', '/var/lib/cloud'),
    'host-services': ('/opt/example-sandbox', '/opt/example-worker', '/data/host', '/usr/local', '/home'),
    'host-logs': ('/var/log', '/var/backups', '/var/mail'),
    'host-layout': (),
}
IMAGE_CONTAINERS = {
    'caddy-image': ('example-gateway',),
    'appnode-image': ('appnode',),
    'base-image': ('base',),
    'nightwarden-images': ('dsh-nightwarden', 'dsh-nightwarden-metrics'),
}

os.umask(0o077)
spec = importlib.util.spec_from_file_location('base_workspace_backup', BASE_CODE)
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def metrics_snapshot(tree):
    info = json.loads(subprocess.check_output(['docker', 'inspect', 'dsh-nightwarden-metrics']))[0]
    args = dict(arg.split('=', 1) for arg in info['Args'] if '=' in arg)
    mounts = {entry['Destination']: entry['Source'] for entry in info['Mounts']}
    if args.get('-storageDataPath') != '/storage' or mounts.get('/storage') != str(METRICS_ROOT):
        raise RuntimeError('metrics storage does not match the registered directory')
    def credential(flag):
        value = args['-httpAuth.' + flag]
        if value.startswith('file://'):
            secret = Path(urllib.parse.urlparse(value).path)
            at = Path('/run/dsh-pass')
            if (secret != at and secret.parent != at) or str(at) not in mounts:
                raise RuntimeError('unexpected metrics credential location')
            value = (Path(mounts[str(at)]) / secret.relative_to(at)).read_text().strip()
        return value
    encoded = base64.b64encode((credential('username') + ':' + credential('password')).encode()).decode()
    def request(action):
        url = 'http://127.0.0.1:18863/snapshot/' + action
        req = urllib.request.Request(url, headers={'Authorization': 'Basic ' + encoded})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=20) as reply:
            response = json.load(reply)
        if response.get('status') != 'ok':
            raise RuntimeError('metrics snapshot API failed')
        return response
    snapshot = request('create')['snapshot']
    if re.fullmatch(r'[0-9A-Za-z_-]+', snapshot) is None:
        raise RuntimeError('unexpected metrics snapshot name')
    backup = tree / 'host' / 'victoriametrics-native'
    backup.mkdir(parents=True)
    try:
        run(['docker', 'run', '--rm', '--network', 'none', '-v', f'{METRICS_ROOT}:/storage:ro',
             '-v', f'{backup}:/backup', f'victoriametrics/vmbackup:{METRICS_VERSION}',
             '-storageDataPath=/storage', '-snapshotName=' + snapshot, '-dst=fs:///backup'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        request('delete?' + urllib.parse.urlencode({'snapshot': snapshot}))
    return backup


def verify_metrics(tree):
    source = tree / 'isolated/host/victoriametrics-native'
    restored = tree / 'metrics-database'
    restored.mkdir()
    run(['docker', 'run', '--rm', '--network', 'none', '-v', f'{source}:/backup:ro',
         '-v', f'{restored}:/storage', f'victoriametrics/vmrestore:{METRICS_VERSION}',
         '-src=fs:///backup', '-storageDataPath=/storage'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return any(restored.iterdir())


def capture_metadata(tree, scope):
    meta = tree / 'metadata'
    meta.mkdir()
    for name in CONTAINERS.get(scope, ()):
        with (meta / (name + '.inspect.json')).open('wb') as f:
            run(['docker', 'inspect', name], stdout=f)
        with (meta / (name + '.changes.txt')).open('wb') as f:
            run(['docker', 'diff', name], stdout=f)
    if scope == 'host-config':
        commands = {
            'block-devices.json': ['lsblk', '-O', '-J'],
            'filesystems.json': ['findmnt', '-J', '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS'],
            'packages.txt': ['dpkg-query', '-W'],
            'enabled-units.txt': ['systemctl', 'list-unit-files', '--no-pager'],
            'docker-networks.json': ['docker', 'network', 'ls', '--format', '{{json .}}'],
            'docker-volumes.json': ['docker', 'volume', 'ls', '--format', '{{json .}}'],
            'loop-devices.json': ['losetup', '-J', '-l', '-O', 'NAME,BACK-FILE,SIZELIMIT,OFFSET'],
        }
        for name, args in commands.items():
            with (meta / name).open('wb') as f:
                run(args, stdout=f)
    if scope == 'host-layout':
        for resource in ('container', 'image', 'network', 'volume'):
            names = subprocess.check_output(['docker', resource, 'ls', '-q'], text=True).splitlines()
            with (meta / f'docker-{resource}-definitions.json').open('wb') as f:
                run(['docker', resource, 'inspect', *dict.fromkeys(names)], stdout=f)
        commands = {
            'interface-addresses.json': ['ip', '-j', 'address', 'show'],
            'routing-tables.json': ['ip', '-j', 'route', 'show', 'table', 'all'],
            'partition-vda.json': ['sfdisk', '--json', '/dev/vda'],
            'partition-vdb.json': ['sfdisk', '--json', '/dev/vdb'],
        }
        for name, args in commands.items():
            with (meta / name).open('wb') as f:
                run(args, stdout=f)


def capture(tree, scope):
    capture_metadata(tree, scope)
    sources = SOURCES.get(scope)
    if scope == 'nightwarden-metrics-native':
        metrics_snapshot(tree)
        sources = ()
    if scope.startswith('base-home-'):
        sources = tuple(sys.argv[3:])
        if not sources or any(Path(p).parent != Path('/data/example-workspace/root') for p in sources):
            raise ValueError('invalid base home entry')
    if scope.startswith('host-root-'):
        sources = tuple(sys.argv[3:])
        if not sources or any(Path(p).parent != Path('/root') for p in sources):
            raise ValueError('invalid host root entry')
    if sources is None:
        raise ValueError('unknown scope')
    samples = {}
    db_samples = []
    db_count = 0
    for label in sources:
        src = Path(label)
        dest = tree / 'host' / src.relative_to('/')
        if scope.startswith(('base-home-', 'host-root-')) and not src.exists() and not src.is_symlink():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir() and not src.is_symlink():
            dest.mkdir(exist_ok=True)
            options = ['rsync', '-aHAXxS', '--numeric-ids', '--no-specials', '--no-devices',
                       '--delete-delay', '--modify-window=-1']
            options += ['--exclude=duplicity.key', '--exclude=example-host-backup.key']
            for attempt in range(3):
                with subprocess.Popen([*options, str(src) + '/', str(dest) + '/'],
                                      stdout=subprocess.DEVNULL) as proc:
                    while proc.poll() is None:
                        if shutil.disk_usage(tree).free < RESERVE:
                            proc.terminate()
                            raise OSError('production disk reserve reached while staging')
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            pass
                if proc.returncode == 0:
                    break
                if proc.returncode != 24 or attempt == 2:
                    raise subprocess.CalledProcessError(proc.returncode, proc.args)
            cloud.SOURCE, cloud.STAGE = src, dest
            db_count += cloud.capture_databases()[0]
        elif src.name not in {'duplicity.key', 'example-host-backup.key'} and not src.is_socket():
            run(['cp', '-a', '--', src, dest])
        for member in itertools.chain([dest], dest.rglob('*')) if dest.is_dir() and not dest.is_symlink() else [dest]:
            if not member.is_file() or member.is_symlink() or member.stat().st_size > 16 * 1024**2:
                continue
            if member.stat().st_size == 0:
                continue
            key = str(member.relative_to(tree))
            if len(samples) < 4:
                samples[key] = cloud.digest(member)
            if len(db_samples) < 2:
                with member.open('rb') as f:
                    if f.read(16) == b'SQLite format 3\x00':
                        db_samples.append(key)
                        samples[key] = cloud.digest(member)
            if len(samples) >= 4 and len(db_samples) >= min(db_count, 2):
                break
    for path in (tree / 'metadata').iterdir():
        samples[str(path.relative_to(tree))] = cloud.digest(path)
    cloud.save(tree / 'metadata' / 'checks.json', {'samples': samples, 'sqlite': db_samples,
               'sqlite_captured': db_count, 'sources': sources})
    return ['tar', '--sort=name', '--sparse', '--acls', '--xattrs', '--xattrs-include=*',
            '--numeric-owner', '-cf', '-', '-C', str(tree), './metadata/checks.json', '.']


def stream_source(tree, scope):
    if scope in IMAGE_CONTAINERS:
        definitions = json.loads(subprocess.check_output(['docker','inspect', *IMAGE_CONTAINERS[scope]]))
        names = []
        for info in definitions:
            name = info['Config']['Image']
            reference = subprocess.run(['docker', 'image', 'inspect', '-f', '{{.Id}}', name],
                                       text=True, capture_output=True)
            names.append(name if reference.returncode == 0 and reference.stdout.strip() == info['Image']
                         else info['Image'])
        return ['docker', 'image', 'save', *dict.fromkeys(names)]
    if scope.startswith('rootfs-') and scope[7:] in {c for names in CONTAINERS.values() for c in names}:
        return ['docker', 'export', scope[7:]]
    return capture(tree, scope)


def gpg(*args):
    return ['gpg', '--batch', '--no-tty', '--pinentry-mode', 'loopback', '--no-symkey-cache',
            '--passphrase-file', KEY, *args]


def encode(scope, job):
    with tempfile.TemporaryDirectory(prefix='capture-', dir=job) as folder:
        tree = Path(folder)
        source = stream_source(tree, scope)
        pieces = job / 'parts'
        pieces.mkdir(exist_ok=True)
        with contextlib.ExitStack() as stack:
            old = stack.enter_context(subprocess.Popen(source, stdout=subprocess.PIPE))
            compressed = stack.enter_context(subprocess.Popen(['zstd', '-q', '-T2', '-3'],
                                              stdin=old.stdout, stdout=subprocess.PIPE))
            old.stdout.close()
            cipher = stack.enter_context(subprocess.Popen(gpg('--symmetric', '--cipher-algo', 'AES256',
                        '--compress-algo', 'none', '--output', '-'), stdin=compressed.stdout, stdout=subprocess.PIPE))
            compressed.stdout.close()
            try:
                result = []
                for index in itertools.count():
                    buf = cipher.stdout.read(CHUNK)
                    if not buf:
                        break
                    if shutil.disk_usage(job).free < RESERVE + len(buf):
                        raise OSError('production disk reserve reached')
                    name = f'archive.tar.zst.gpg.part-{index:05d}'
                    (pieces / name).write_bytes(buf)
                    result.append({'name': name, 'size': len(buf), 'sha256': hashlib.sha256(buf).hexdigest()})
                for process in (cipher, compressed, old):
                    if process.wait():
                        raise RuntimeError('archive pipeline failed')
            except BaseException:
                for process in (cipher, compressed, old):
                    if process.poll() is None:
                        process.terminate()
                raise
        if not result:
            raise RuntimeError('empty archive')
        return result


def download_and_check(info, row, folder, link=None):
    path = folder / info['name']
    with tempfile.TemporaryDirectory(dir=folder) as d:
        received = Path(d) / 'received'
        for attempt, delay in enumerate((0, 5, 15)):
            time.sleep(delay)
            try:
                if attempt == 0 and link is None:
                    cloud.bd('download', cloud.REMOTE + '/' + info['name'], received, timeout=420)
                else:
                    cloud.download_object(row, received, link=link)
                if received.stat().st_size != info['size'] or cloud.digest(received) != info['sha256']:
                    raise RuntimeError('cloud digest mismatch')
            except cloud.BaiduRateLimit:
                raise
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                received.unlink(missing_ok=True)
                if attempt == 2:
                    raise
            else:
                received.replace(path)
                break
    return path


def restore_cloud(scope, job, manifest, rows, progress):
    with tempfile.TemporaryDirectory(prefix='readback-', dir=job) as directory:
        tmp = Path(directory)
        workers = 6 if len(manifest['parts']) >= 32 else WORKERS
        with subprocess.Popen(gpg('--decrypt'), stdin=subprocess.PIPE, stdout=subprocess.PIPE) as plain:
            with subprocess.Popen(['zstd', '-q', '-d'], stdin=plain.stdout, stdout=subprocess.PIPE) as stream:
                plain.stdout.close()
                def feed():
                    try:
                        with concurrent.futures.ThreadPoolExecutor(workers) as pool:
                            parts = manifest['parts']
                            for start in range(0, len(parts), cloud.FILEMETA_BATCH):
                                batch = parts[start:start + cloud.FILEMETA_BATCH]
                                links = cloud.download_links([rows[part['name']] for part in batch])
                                for offset in range(0, len(batch), workers):
                                    group = batch[offset:offset + workers]
                                    reads = []
                                    for part in group:
                                        row = rows[part['name']]
                                        reads.append(pool.submit(download_and_check, part, row, tmp,
                                                                 links[cloud.object_id(row)]))
                                    for future in reads:
                                        path = future.result()
                                        with path.open('rb') as f:
                                            shutil.copyfileobj(f, plain.stdin)
                                        path.unlink()
                                    progress(downloaded=start + offset + len(group))
                    finally:
                        plain.stdin.close()
                with concurrent.futures.ThreadPoolExecutor(1) as threading:
                    fed = threading.submit(feed)
                    try:
                        checks = examine_archive(scope, stream.stdout, tmp)
                    except BaseException:
                        if stream.poll() is None:
                            stream.kill()
                        if plain.poll() is None:
                            plain.kill()
                        if fed.done():
                            error = fed.exception()
                            if isinstance(error, cloud.BaiduRateLimit):
                                raise error from None
                        raise
                    finally:
                        stream.stdout.close()
                    fed.result()
            if stream.returncode or plain.wait():
                raise RuntimeError('cloud data failed GPG or zstd verification')
        if scope == 'caddy':
            checks['caddy_config_valid'] = caddy_verify(tmp / 'isolated')
        if scope == 'nightwarden-metrics-native':
            if not verify_metrics(tmp):
                raise RuntimeError('native metrics backup did not restore database files')
            checks['metrics_restore_valid'] = True
        return checks


def examine_archive(scope, stream, tmp):
    if scope in {'caddy', 'nightwarden-metrics-native'}:
        with tempfile.TemporaryFile(dir=tmp) as recovered:
            shutil.copyfileobj(stream, recovered)
            recovered.seek(0)
            with tarfile.open(fileobj=recovered, mode='r:') as archive:
                archive.extractall(tmp / 'isolated', filter='data')
            recovered.seek(0)
            return check_members(scope, recovered, tmp)
    return check_members(scope, stream, tmp)


def check_members(scope, stream, tmp):
    data_archive = scope not in IMAGE_CONTAINERS and not scope.startswith('rootfs-')
    expected = None
    seen = {}
    members = 0
    dbs = {}
    image_manifest = False
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            members += 1
            name = member.name.removeprefix('./')
            if not data_archive:
                image_manifest |= name == 'manifest.json'
                continue
            if not member.isfile() or member.size > 16*1024**2:
                continue
            with archive.extractfile(member) as f:
                if name == 'metadata/checks.json':
                    expected = json.load(f)
                elif expected and name in expected['samples']:
                    contents = f.read()
                    seen[name] = hashlib.sha256(contents).hexdigest()
                    if name in expected['sqlite']:
                        dest = tmp / ('db-' + str(len(dbs)))
                        dest.write_bytes(contents)
                        with contextlib.closing(sqlite3.connect(dest.as_uri() + '?immutable=1', uri=True)) as db:
                            dbs[name] = db.execute('PRAGMA quick_check').fetchall() == [('ok',)]
    while stream.read(1024**2):
        pass
    if not members:
        raise RuntimeError('empty restored tar')
    if data_archive and (not expected or expected['samples'] != seen or
                         set(expected['sqlite']) != dbs.keys() or not all(dbs.values())):
        raise RuntimeError('restored files or SQLite verification failed')
    if scope in IMAGE_CONTAINERS and not image_manifest:
        raise RuntimeError('restored Docker image is missing manifest.json')
    return {'archive_members': members, 'checked_files': len(seen),
            'sqlite_samples': len(dbs), 'sqlite_captured': (expected or {}).get('sqlite_captured',0)}


def caddy_verify(tree):
    config = tree / 'host/opt/example-edge'
    data = tree / 'host/var/lib/docker/volumes/example-edge_caddy_data/_data'
    state = tree / 'host/var/lib/docker/volumes/example-edge_caddy_config/_data'
    info = json.loads((tree / 'metadata/example-gateway.inspect.json').read_text())[0]
    with (tree / 'caddy.env').open('w') as env:
        for value in info['Config']['Env']:
            if '\n' not in value:
                env.write(value + '\n')
    run(['docker', 'compose', '--project-directory', str(config), '-f', str(config / 'docker-compose.yml'),
         'config', '--quiet'], stdout=subprocess.DEVNULL)
    run(['docker', 'run', '--rm', '--network', 'none', '--env-file', tree / 'caddy.env',
         '-v', f'{config / "Caddyfile"}:/etc/caddy/Caddyfile:ro', '-v', f'{data}:/data',
         '-v', f'{state}:/config', '--entrypoint', 'caddy', info['Image'],
         'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
         stdout=subprocess.DEVNULL)
    return True


def upload_archive(job, rows, parts, progress):
    def upload(part):
        local = job / 'parts' / part['name']
        try:
            cloud.bd('upload', local, cloud.REMOTE + '/' + part['name'])
        except (RuntimeError, subprocess.TimeoutExpired):
            pass

    workers = 6 if len(parts) >= 32 else WORKERS
    batch_size = 8
    if len(parts) >= 64:
        workers = 10
        batch_size = 16
    with concurrent.futures.ThreadPoolExecutor(workers) as pool:
        for offset in range(0, len(parts), batch_size):
            batch = parts[offset:offset + batch_size]
            for delay in (0, 5, 20):
                missing = [p for p in batch if rows.get(p['name'], {}).get('size') != p['size']]
                if not missing:
                    break
                time.sleep(delay)
                list(pool.map(upload, missing))
                rows = list_archive()
            for part in batch:
                local = job / 'parts' / part['name']
                row = rows.get(part['name'], {})
                if row.get('size') != part['size']:
                    raise RuntimeError('cloud part is absent or incomplete')
                if not cloud.cloud_md5_matches(row.get('md5'), cloud.digest(local, 'md5')):
                    with tempfile.TemporaryDirectory(dir=job) as temp:
                        download_and_check(part, row, Path(temp))
            progress(uploaded=min(offset+batch_size, len(parts)))
    return rows


def publish_metadata(local, name):
    for attempt, delay in enumerate((0, 5, 20)):
        time.sleep(delay)
        try:
            if attempt:
                previous = cloud.listing(cloud.REMOTE).get(name, {})
                if previous.get('size') == local.stat().st_size and cloud.cloud_md5_matches(
                        previous.get('md5'), cloud.digest(local, 'md5')):
                    return
            cloud.bd('upload', local, cloud.REMOTE + '/' + name)
            return
        except (RuntimeError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise


def list_archive():
    for attempt, delay in enumerate((0, 5, 20)):
        time.sleep(delay)
        try:
            return cloud.listing(cloud.REMOTE)
        except (RuntimeError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise


def execute(scope, run_id):
    cloud.REMOTE = f'example-host-recovery-{run_id}-{scope}'
    job = ROOT / run_id / scope
    job.mkdir(parents=True, exist_ok=True)
    repo_marker = job / 'encoded.json'
    marker = job / 'verified.json'
    capture_only = os.environ.get('DSH_RECOVERY_CAPTURE_ONLY') == '1'
    if marker.exists() or (capture_only and repo_marker.exists()):
        return
    start = int(time.time())
    current = {'scope': scope, 'cloud_directory': cloud.REMOTE, 'started': start}
    def progress(**kwargs):
        current.update(kwargs, updated=int(time.time()))
        cloud.save(job / 'progress.json', current)
    try:
        if repo_marker.exists():
            manifest = json.loads(repo_marker.read_text())
            current['started'] = manifest['started']
        else:
            progress(phase='capturing')
            manifest = {'format': 'concatenate in listed order; GPG AES256; zstd; tar',
                        'cloud_directory': cloud.REMOTE, 'scope': scope,
                        'started': start, 'parts': encode(scope, job)}
            cloud.save(repo_marker, manifest)
        parts = manifest['parts']
        if capture_only:
            progress(phase='captured', parts=len(parts), bytes=sum(p['size'] for p in parts))
            return
        progress(phase='uploading', parts=len(parts), bytes=sum(p['size'] for p in parts))
        if not cloud.bd('whoami').get('has_valid_token'):
            raise RuntimeError('Baidu session not authorized')
        rows = ensure_remote_directory()

        published = job / 'published.json'
        sizes_match = all(rows.get(p['name'], {}).get('size') == p['size'] for p in parts)
        if not published.exists() or not sizes_match or 'manifest.json' not in rows:
            rows = upload_archive(job, rows, parts, progress)
            publish_metadata(repo_marker, 'manifest.json')
            cloud.save(published, {'published_at': int(time.time())})
        progress(phase='uploaded', uploaded=len(parts))
        if os.environ.get('DSH_RECOVERY_UPLOAD_ONLY') == '1':
            return
        progress(phase='restoring', downloaded=0)
        checks = restore_cloud(scope, job, manifest, rows, progress)
        receipt = {**current, **checks, 'verified_at': int(time.time()), 'phase': 'verified'}
        local_receipt = job / 'cloud-receipt.json'
        cloud.save(local_receipt, receipt)
        publish_metadata(local_receipt, 'verified.json')
        cloud.save(marker, receipt)
        progress(**receipt)
        shutil.rmtree(job / 'parts')
    except BaseException as error:
        progress(phase='failed', failed_stage=current.get('phase'), error_type=type(error).__name__)
        raise


def ensure_remote_directory():
    for attempt, delay in enumerate((0, 5, 20)):
        time.sleep(delay)
        try:
            if cloud.REMOTE not in cloud.listing(''):
                cloud.bd('mkdir', cloud.REMOTE)
            return cloud.listing(cloud.REMOTE)
        except (RuntimeError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise


def split_directory(root, prefix):
    result = subprocess.check_output(['du', '-0', '-x', '-a', '-B1', '--max-depth=1', root])
    groups = []
    for row in result.split(b'\0'):
        if not row:
            continue
        size, name = row.split(b'\t', 1)
        if os.fsdecode(name) == root:
            continue
        size = int(size)
        for group in groups:
            if group['bytes'] + size <= GROUP_BYTES:
                break
        else:
            group = {'scope': f'{prefix}-{len(groups)+1:02d}', 'bytes': 0, 'sources': []}
            groups.append(group)
        group['bytes'] += size
        group['sources'].append(os.fsdecode(name))
    return groups


def back_up_remaining(run_id):
    root = ROOT / run_id
    plan = root / 'remaining-plan.json'
    if plan.exists():
        groups = json.loads(plan.read_text())
    else:
        groups = [{'scope': scope, 'sources': []} for scope in (
            'rootfs-example-gateway', 'rootfs-example-site',
            'nightwarden-images', 'rootfs-dsh-nightwarden', 'rootfs-dsh-nightwarden-metrics',
            'host-services', 'host-logs', 'base-tmp', 'base-image', 'rootfs-base',
        )]
        groups += split_directory('/data/example-workspace/root', 'base-home')
        groups += split_directory('/root', 'host-root')
        cloud.save(plan, groups)
    failures = []
    previous = None
    with concurrent.futures.ThreadPoolExecutor(1) as verifier:
        for group in groups:
            args = [sys.executable, '-I', __file__, group['scope'], run_id, *group['sources']]
            uplink = {**os.environ, 'DSH_RECOVERY_UPLOAD_ONLY': '1'}
            uplink_result = subprocess.run(args, env=uplink).returncode
            if previous is not None:
                completed_scope, checked = previous
                if checked.result():
                    failures.append(completed_scope)
                previous = None
            if uplink_result and retry_job(args, uplink):
                failures.append(group['scope'])
                continue
            previous = group['scope'], verifier.submit(retry_job, args)
        if previous is not None:
            completed_scope, checked = previous
            if checked.result():
                failures.append(completed_scope)
    cloud.save(root / 'remaining-result.json', {'completed_at': int(time.time()), 'failed': failures})
    return publish_catalog(root, run_id, groups)


def retry_job(args, env=None):
    for delay in (0, 30, 120):
        time.sleep(delay)
        if not subprocess.run(args, env=env).returncode:
            return False
    return True


def publish_catalog(root, run_id, groups):
    scopes = set(SOURCES)
    scopes.update(IMAGE_CONTAINERS)
    scopes.update(group['scope'] for group in groups)
    scopes.update({'nightwarden-metrics-native', 'rootfs-appnode'})
    entries = []
    for scope in sorted(scopes):
        status = root / scope / 'progress.json'
        data = json.loads(status.read_text()) if status.exists() else {'phase': 'missing'}
        entries.append({'scope': scope, 'phase': data['phase'], 'started': data.get('started'),
                        'verified_at': data.get('verified_at'), 'bytes': data.get('bytes'),
                        'folder': f'example-host-recovery-{run_id}-{scope}'})
    base = json.loads(Path('/data/dsh-workspace-archives/latest.json').read_text())
    entries.append({'scope': 'base-workspace', 'phase': base['status'], 'started': base['started'],
                    'verified_at': base.get('verified_at'), 'folder': base['cloud_directory']})
    complete = all(entry['phase'] == 'verified' for entry in entries)
    captured = int(time.time())
    report = root / f'status-{captured}.json'
    cloud.save(report, {'vps': 'example-host', 'run_id': run_id, 'captured_at': captured,
                        'mode': 'online component recovery', 'components_verified': complete,
                        'bare_metal_boot_tested': False, 'entries': entries})
    cloud.REMOTE = f'example-host-recovery-{run_id}-index'
    ensure_remote_directory()
    publish_metadata(report, report.name)
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        restored = Path(tmp) / report.name
        cloud.bd('download', cloud.REMOTE + '/' + report.name, restored)
        if cloud.digest(restored) != cloud.digest(report):
            raise RuntimeError('cloud inventory checksum mismatch')
    return not complete


if __name__ == '__main__':
    newer_sqlite = ROOT / 'sqlite-3.54.1'
    if sqlite3.sqlite_version_info < (3, 43, 0) and (newer_sqlite / 'libsqlite3.so.0').is_file():
        if os.environ.get('LD_LIBRARY_PATH') == str(newer_sqlite):
            raise RuntimeError('recovery SQLite library did not load')
        os.execve(sys.executable, [sys.executable, '-I', *sys.argv],
                  {**os.environ, 'LD_LIBRARY_PATH': str(newer_sqlite)})
    scope, run_id = sys.argv[1:3]
    if not re.fullmatch(r'[a-z0-9-]+', scope) or not re.fullmatch(r'[0-9]{8}-[0-9]{4}', run_id):
        raise SystemExit('invalid scope or run id')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    with (ROOT / f'{run_id}-{scope}.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if scope == 'remaining':
            sys.exit(back_up_remaining(run_id))
        execute(scope, run_id)
