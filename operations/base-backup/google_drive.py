"""Second, independently verified destination for the enrolled base workspace."""
import configparser
import contextlib
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import time

BASE = Path('/data/dsh-workspace-archives')
PRIVATE = Path('/var/lib/dsh-workspace-private')
CONFIG = PRIVATE / 'google-drive.conf'
ROOT = BASE / 'google-drive'
FOLDER = 'DSH-example-host-base-workspace'
REMOTE = 'dsh-google:'
ARCHIVE = 'volumes'
SERVICE = 'dsh-base-google-drive.service'
STAMP = r'\d{8}T\d{6}Z'
MANIFEST = re.compile(rf'duplicity-(?:full\.({STAMP})|inc\.({STAMP})\.to\.({STAMP}))\.manifest\.gpg')
os.umask(0o077)


def read(path, fallback=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def save(path, value):
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as out:
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(out.name, path)


@contextlib.contextmanager
def lock(name):
    ROOT.mkdir(exist_ok=True)
    with (ROOT / name).open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('已有任务运行，请稍后重试') from None
        yield


def settings(path):
    conf = configparser.RawConfigParser()
    conf.read(path)
    return conf


def target():
    key = settings(CONFIG).get('dsh-google', 'root_folder_id', fallback='')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', key):
        raise ValueError('需要连接 Google Drive')
    directory = ROOT / key
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def rc(*args, config=CONFIG):
    result = subprocess.run(['rclone', '--config', str(config), *map(str, args)],
                            capture_output=True, timeout=12*3600)
    if result.returncode:
        reason = result.stderr.lower()
        if any(s in reason for s in (b'invalid_grant', b'invalid_client', b'401 unauthorized')):
            raise ValueError('Google 授权失效，请重新连接')
        if b'storagequotaexceeded' in reason:
            raise ValueError('Google 云端空间不足')
        if b'ratelimit' in reason or b'quota' in reason:
            raise ValueError('Google 配额受限，稍后重试')
        raise ValueError('网盘传输或校验失败，请检查连接后重试')
    return result.stdout


def connect(client):
    # SSH forwards the rclone loopback listener. Only its local URL may reach DSH.
    with lock('authorize.lock'), tempfile.TemporaryDirectory(dir=PRIVATE) as tmp:
        path = Path(tmp) / 'rclone.conf'
        prior = settings(CONFIG)
        if client is None and prior.has_section('dsh-google'):
            client = dict(prior['dsh-google'])
        if not isinstance(client, dict):
            raise ValueError('请选择桌面应用客户端 JSON 文件')
        cid, secret = client.get('client_id', ''), client.get('client_secret', '')
        if not re.fullmatch(r'[A-Za-z0-9.-]+\.apps\.googleusercontent\.com', cid) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', secret):
            raise ValueError('Google 桌面应用客户端格式有误')
        conf = configparser.RawConfigParser()
        conf['dsh-google'] = dict(type='drive', scope='drive.file', client_id=cid, client_secret=secret)
        with path.open('w') as out:
            conf.write(out)
        command = ['rclone', '--config', str(path), 'config', 'reconnect', REMOTE, '--auto-confirm']
        # timeout also terminates the OAuth listener if the SSH session disappears.
        with subprocess.Popen(['timeout', '600', *command], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) as child:
            for line in child.stdout:
                match = re.search(r'http://127\.0\.0\.1:53682/auth\?state=[A-Za-z0-9_%=-]+', line)
                if match:
                    print(json.dumps({'url': match[0]}), flush=True)
            if child.wait():
                raise ValueError('Google 授权未完成或已超时')
        rc('mkdir', REMOTE + FOLDER, config=path)
        rows = json.loads(rc('lsjson', REMOTE, '--dirs-only', config=path))
        folders = [r['ID'] for r in rows if r['Name'] == FOLDER]
        if len(folders) != 1 or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', folders[0]):
            raise ValueError('备份目录重名或无法核对')
        conf = settings(path)
        conf['dsh-google']['root_folder_id'] = folders[0]
        with path.open('w') as out:
            conf.write(out)
        probe = Path(tmp) / 'connection-v1.txt'
        probe.write_bytes(b'DSH Google Drive backup v1\n')
        rc('copyto', '--immutable', '--checksum', probe, REMOTE + probe.name, config=path)
        if rc('cat', REMOTE + probe.name, config=path) != probe.read_bytes():
            raise ValueError('连接测试文件回读失败')
        with lock('transfer.lock'):
            os.replace(path, CONFIG)
        start_backup()


def start_backup():
    target()
    subprocess.run(['systemctl', 'start', '--no-block', SERVICE], check=True)


def source():
    # Each input is an atomic receipt. In-flight Baidu uploads already have sealed volumes.
    points = [read(BASE / name) for name in ('latest.json', 'pending.json')]
    newest = max((BASE / 'sealed').glob('*.json'), default=None)
    if newest is not None:
        points.append(read(newest))
    points = [p for p in points if p and p.get('packed_at') and p.get('recovery_samples')]
    if not points:
        raise ValueError('等待工作区生成首个加密版本')
    return max(points, key=lambda p: p['started'])


def manifest_volumes(path, key):
    # Counting the encrypted manifest’s Volume records detects a missing trailing volume.
    cmd = ['gpg', '--batch', '--pinentry-mode', 'loopback', '--passphrase-file', str(key),
           '--decrypt', str(path)]
    count = 0
    consecutive = True
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as proc:
        for line in proc.stdout:
            match = re.fullmatch(rb'Volume (\d+):\s*', line)
            if match:
                count += 1
                if int(match[1]) != count:
                    consecutive = False
        if proc.wait() or not count or not consecutive:
            raise ValueError('无法核验本地加密清单')
    return count


def snapshot(repo, dest, point, key):
    manifests = {}
    for path in repo.glob('*.manifest.gpg'):
        match = MANIFEST.fullmatch(path.name)
        if match:
            end = match[1] or match[3]
            if end in manifests:
                raise ValueError('加密仓库中存在重复的版本时间')
            manifests[end] = (match[2], path)
    times = [t for t in manifests if point['started'] <=
             datetime.strptime(t, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).timestamp() <= point['packed_at']]
    if len(times) != 1:
        raise ValueError('无法唯一匹配已封存的工作区版本')
    version = times[0]
    current = version
    while current:
        if current not in manifests:
            raise ValueError('本地增量链缺少前序清单')
        previous, manifest = manifests[current]
        if previous and previous >= current:
            raise ValueError('本地增量链时间不连续')
        stem = manifest.name.removesuffix('.manifest.gpg')
        signature = (f'duplicity-new-signatures.{previous}.to.{current}' if previous else
                     f'duplicity-full-signatures.{current}') + '.sigtar.gpg'
        volumes = list(repo.glob(stem + '.vol*.difftar.gpg'))
        numbers = sorted(int(p.name[len(stem)+4:-len('.difftar.gpg')]) for p in volumes)
        if not numbers or numbers != list(range(1, manifest_volumes(manifest, key)+1)):
            raise ValueError('本地加密仓库分卷不连续')
        for path in [*volumes, repo / signature, manifest]:
            os.link(path, dest / path.name)
        current = previous
    return version


def validate_remote(local, remote, config, include_manifests):
    rows = json.loads(rc('lsjson', remote, '--files-only', '--hash', config=config))
    lookup = {}
    for row in rows:
        if row['Name'] in lookup:
            raise ValueError('网盘存在同名分卷，请检查备份目录')
        lookup[row['Name']] = row
    for path in local.iterdir():
        if ('.manifest.' in path.name) != include_manifests:
            continue
        row = lookup.get(path.name)
        if row is None or row['Size'] != path.stat().st_size:
            raise ValueError('网盘分卷缺失或大小不符')
        expected = row.get('Hashes', {}).get('MD5')
        if expected:
            with path.open('rb') as stream:
                checksum = hashlib.md5()
                for block in iter(lambda: stream.read(1024*1024), b''):
                    checksum.update(block)
            if checksum.hexdigest() != expected.lower():
                raise ValueError('网盘分卷内容摘要不符')
        else:
            with tempfile.TemporaryDirectory(dir=local.parent) as tmp:
                copy = Path(tmp) / 'volume'
                rc('copyto', remote + '/' + path.name, copy, config=config)
                if sha256(copy) != sha256(path):
                    raise ValueError('网盘分卷回读不符')


def sha256(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            checksum.update(block)
    return checksum.hexdigest()


def restore_sample(sample, version, destination, cache, config, key):
    rel = Path(sample['path'])
    if rel.is_absolute() or '..' in rel.parts or not rel.parts:
        raise ValueError('恢复样本路径无效')
    env = {**os.environ, 'RCLONE_CONFIG': str(config), 'PASSPHRASE': key.read_text().strip()}
    when = datetime.strptime(version, '%Y%m%dT%H%M%SZ').strftime('%Y-%m-%dT%H:%M:%SZ')
    run = subprocess.run(['duplicity', 'restore', '--time', when, '--archive-dir', str(cache),
                          '--file-to-restore', str(rel), 'rclone://dsh-google:/' + ARCHIVE,
                          str(destination)], env=env, capture_output=True, timeout=6*3600)
    if run.returncode or not destination.is_file() or sha256(destination) != sample['sha256']:
        raise ValueError('从网盘恢复的样本未通过校验')
    if sample['kind'] == 'sqlite':
        with sqlite3.connect(destination.as_uri() + '?mode=ro&immutable=1', uri=True) as db:
            if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                raise ValueError('恢复的数据库未通过完整性检查')


def publish(point, directory, repo, config, key):
    point_id = str(point['started'])
    receipt = directory / 'receipts' / (point_id + '.json')
    receipt.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=directory) as tmp:
        tmp = Path(tmp)
        local = tmp / 'volumes'
        local.mkdir()
        version = snapshot(repo, local, point, key)
        remote = REMOTE + ARCHIVE
        def phase(name):
            save(directory / 'progress.json', {'phase': name, 'point': point['started']})
        phase('上传并核验分卷')
        for manifests in (False, True):
            rc('copy', local, remote, '--checksum', '--immutable',
               '--include' if manifests else '--exclude', '*.manifest.gpg',
               '--transfers', '3', config=config)
            validate_remote(local, remote, config, manifests)
        phase('从网盘恢复样本')
        samples = point['recovery_samples']
        for index, sample in enumerate(samples):
            restore_sample(sample, version, tmp / f'sample-{index}', tmp / 'cache', config, key)
        receipt_data = {'started': point['started'], 'version': version, 'verified_at': int(time.time()),
                        'samples': samples}
        # The operator can locate the verified time even after losing the local ledger.
        cloud_receipt = REMOTE + 'receipts/' + point_id + '.json'
        # Use stable content for retries after the server loses a response.
        save(tmp / 'receipt.json', {'started': point['started'], 'version': version})
        rc('copyto', tmp / 'receipt.json', cloud_receipt, '--immutable', '--checksum', config=config)
        if json.loads(rc('cat', cloud_receipt, config=config)) != read(tmp / 'receipt.json'):
            raise ValueError('恢复点回执回读失败')
        save(receipt, receipt_data)
        if read(directory / 'latest.json', {}).get('started', 0) <= point['started']:
            save(directory / 'latest.json', receipt_data)
        phase('已验证')


def backup():
    with lock('transfer.lock'):
        directory = target()
        try:
            queue = [p for p in sorted((BASE / 'sealed').glob('*.json'))
                     if not (directory / 'receipts' / p.name).exists()]
            for record in queue:
                publish(read(record), directory, BASE / 'volumes-v2', CONFIG, PRIVATE / 'duplicity.key')
            if queue:
                return
            point = source()
            if read(directory / 'latest.json', {}).get('started', 0) >= point['started']:
                # Detect expired grants even between new snapshots.
                saved = read(directory / 'latest.json')
                name = REMOTE + 'receipts/' + str(saved['started']) + '.json'
                if json.loads(rc('cat', name)) != {'started': saved['started'], 'version': saved['version']}:
                    raise ValueError('云端恢复点回执不符')
                save(directory / 'progress.json', {'phase': '已验证'})
                return
            publish(point, directory, BASE / 'volumes-v2', CONFIG, PRIVATE / 'duplicity.key')
        except Exception as error:
            reason = str(error) if type(error) is ValueError else '本地分卷、磁盘或网盘作业异常'
            save(directory / 'progress.json', {'phase': '等待重试', 'reason': reason})
            raise


def status():
    if not CONFIG.exists():
        return {'connected': False}
    directory = target()
    latest = read(directory / 'latest.json', {})
    unit = subprocess.run(['systemctl', 'show', '--property=ActiveState', '--value', SERVICE],
                          capture_output=True, text=True)
    active = unit.stdout.strip() in ('active', 'activating') if unit.returncode == 0 else None
    return {'connected': True, 'active': active, 'progress': read(directory / 'progress.json', {}),
            'started': latest.get('started'), 'verified_at': latest.get('verified_at'),
            'versions': sorted([int(p.stem) for p in (directory / 'receipts').glob('*.json')], reverse=True)}


def recover(point):
    with lock('transfer.lock'):
        directory = target()
        if type(point) is not int or point <= 0:
            raise ValueError('请选择已验证的恢复点')
        receipt = read(directory / 'receipts' / f'{point}.json')
        if not receipt:
            raise ValueError('找不到指定恢复点')
        with tempfile.TemporaryDirectory(dir=directory) as tmp:
            output = Path(tmp) / 'samples'
            output.mkdir()
            for sample in receipt['samples']:
                dest = output / sample['path']
                dest.parent.mkdir(parents=True, exist_ok=True)
                restore_sample(sample, receipt['version'], dest, Path(tmp) / 'cache', CONFIG,
                               PRIVATE / 'duplicity.key')
            final = Path(tempfile.mkdtemp(prefix=f'restored-{point}-', dir=directory))
            output.rename(final / 'samples')
            return {'directory': str(final / 'samples')}


def main():
    if sys.argv[1:] == ['backup']:
        backup()
        return
    action, identity = sys.argv[1:]
    if hashlib.sha256(Path('/etc/machine-id').read_bytes().strip()).hexdigest() != identity:
        raise ValueError('主机身份与登记信息不符')
    if (BASE / 'owner').read_text().strip() != 'DSH base workspace backup v1':
        raise ValueError('尚未登记工作区备份')
    payload = json.load(sys.stdin)
    if action == 'connect':
        connect(payload.get('client'))
    elif action == 'status':
        print(json.dumps(status()))
    elif action == 'retry':
        start_backup()
        print('{}')
    elif action == 'restore':
        print(json.dumps(recover(payload.get('point'))))
    else:
        raise ValueError('未知操作')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Third-party output, paths and credentials never enter the workbench or journal.
        print(json.dumps({'error': str(error) if type(error) is ValueError and not isinstance(error, json.JSONDecodeError)
                          else '网盘任务失败，请检查服务器状态'}), flush=True)
        sys.exit(1)
