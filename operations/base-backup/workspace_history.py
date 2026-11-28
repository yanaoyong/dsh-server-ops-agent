"""Browse sealed duplicity versions and recover selected workspace items into private directories."""
import codecs
import fcntl
import gzip
import hashlib
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import tarfile
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path('/data/dsh-workspace-archives')
PRIVATE = Path('/var/lib/dsh-workspace-private')
REPO = BASE / 'volumes-v2'
ROOT = BASE / 'file-history'
STAMP = r'[0-9]{8}T[0-9]{6}Z'
MANIFEST = re.compile(rf'duplicity-(?:full\.|inc\.{STAMP}\.to\.)({STAMP})\.manifest\.gpg')
ENTRY = re.compile(rb"INFO 10 \S+ '(.*)' (\w+)")
PAGE = 100
os.umask(0o077)


def read(path):
    return json.loads(path.read_text())


def version_time(version):
    return datetime.strptime(version, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)


def points():
    manifests = sorted((version_time(m[1]).timestamp(), m[1]) for p in REPO.glob('*.manifest.gpg')
                       if (m := MANIFEST.fullmatch(p.name)))
    records = {}
    for folder in ('receipts', 'sealed'):
        for p in (BASE / folder).glob('*.json'):
            row = read(p)
            records[row['started']] = row
    pending = BASE / 'pending.json'
    try:
        row = read(pending)
        if row.get('packed_at'):
            records[row['started']] = row
    except FileNotFoundError:
        pass
    google = None
    config = PRIVATE / 'google-drive.conf'
    if config.exists():
        import configparser
        parser = configparser.RawConfigParser()
        parser.read(config)
        folder = parser.get('dsh-google', 'root_folder_id', fallback='')
        if re.fullmatch(r'[A-Za-z0-9_-]{1,200}', folder):
            google = BASE / 'google-drive' / folder / 'receipts'
    result = []
    for start, row in sorted(records.items(), reverse=True):
        versions = [v for ts, v in manifests if start <= ts <= row.get('packed_at', 0)]
        if len(versions) != 1:
            continue
        v = versions[0]
        gr = google / f'{start}.json' if google else None
        result.append(dict(point=start, version=v,
                           baidu=(BASE / 'receipts' / f'{start}.json').is_file(),
                           google=bool(gr and gr.is_file() and read(gr).get('version') == v)))
    return result


def relative(path, allow_root=False):
    if allow_root and path == '':
        return path
    if not isinstance(path, str) or len(os.fsencode(path)) > 4096 or '\0' in path or any(
            part in ('', '.', '..') for part in path.split('/')):
        raise ValueError('请选择历史目录内的项目')
    return path


def environment():
    return {**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC', 'RCLONE_CONFIG': str(PRIVATE / 'google-drive.conf'),
            'PASSPHRASE': (PRIVATE / 'duplicity.key').read_text().strip()}


def seed_read_cache(cache):
    # Only immutable completed local signatures/manifests; never share locks or writer state.
    for archive in (BASE / 'archive-cache-v2').glob('*'):
        if not archive.is_dir() or not re.fullmatch(r'[a-f0-9]{32}', archive.name):
            continue
        dest = cache / archive.name
        dest.mkdir(parents=True, exist_ok=True)
        for path in archive.iterdir():
            if path.name.startswith('duplicity-') and path.name.endswith(('.sigtar.gz', '.manifest')):
                os.link(path, dest / path.name)


def cached_signatures(version):
    # Duplicity 0.8 keeps completed, decrypted signatures in its per-repository cache.
    cache = BASE / 'archive-cache-v2' / hashlib.md5(REPO.as_uri().encode()).hexdigest()
    chain = []
    while True:
        full = cache / f'duplicity-full-signatures.{version}.sigtar.gz'
        if full.is_file():
            return [(version, full), *reversed(chain)]
        matches = list(cache.glob(f'duplicity-new-signatures.*.to.{version}.sigtar.gz'))
        if len(matches) != 1:
            return []
        m = re.fullmatch(rf'duplicity-new-signatures\.({STAMP})\.to\.({STAMP})\.sigtar\.gz', matches[0].name)
        if not m or m[1] >= version:
            return []
        chain.append((version, matches[0]))
        version = m[1]


def index_signatures(dest, chain):
    # Apply the same three entry types as duplicity.diffdir.sigtar2path_iter.
    # File payloads here are signatures, so their sizes are not original file sizes.
    with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        working = Path(tmp) / 'catalog'
        for index in range(len(chain)-2, -1, -1):
            prior = ROOT / (chain[index][0] + '.sqlite')
            if prior.exists():
                shutil.copyfile(prior, working)
                chain = chain[index+1:]
                break
        with sqlite3.connect(working) as db:
            db.execute('CREATE TABLE IF NOT EXISTS files(parent BLOB,name BLOB,kind TEXT,PRIMARY KEY(parent,name)) WITHOUT ROWID')
            for _, sig in chain:
                with gzip.open(sig, 'rb') as stream, tarfile.open(fileobj=stream, mode='r|') as archive:
                    for entry in archive:
                        archive.members.clear()
                        op, _, path = entry.name.partition('/')
                        if op not in ('signature','snapshot','deleted'):
                            raise ValueError('未识别的归档签名')
                        if not path:
                            continue
                        parent, _, name = relative(path).rpartition('/')
                        key = (os.fsencode(parent), os.fsencode(name))
                        if op == 'deleted':
                            db.execute('DELETE FROM files WHERE parent=? AND name=?', key)
                        else:
                            kind = {tarfile.REGTYPE:'reg', tarfile.AREGTYPE:'reg', tarfile.DIRTYPE:'dir',
                                    tarfile.SYMTYPE:'sym', tarfile.FIFOTYPE:'fifo',
                                    tarfile.CHRTYPE:'chr', tarfile.BLKTYPE:'blk'}.get(entry.type, 'special')
                            db.execute('INSERT OR REPLACE INTO files VALUES(?,?,?)', (*key, kind))
        os.replace(working, dest)


def index_catalog(dest, version):
    signatures = cached_signatures(version)
    if signatures:
        index_signatures(dest, signatures)
        return
    with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        dbpath = Path(tmp) / 'catalog'
        with sqlite3.connect(dbpath) as db:
            db.execute('CREATE TABLE files(parent TEXT,name TEXT,kind TEXT,PRIMARY KEY(parent,name)) WITHOUT ROWID')
            # Use the tool's escaped machine log so spaces, quotes and newlines survive.
            seed_read_cache(Path(tmp) / 'cache')
            machine_log = Path(tmp) / 'listing'
            cmd = ['duplicity', 'list-current-files', '--time', version_time(version).strftime('%Y-%m-%dT%H:%M:%SZ'),
                   '--archive-dir', tmp + '/cache', '--log-file', str(machine_log), REPO.as_uri()]
            run = subprocess.run(cmd, env=environment(), stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, timeout=1800)
            if run.returncode:
                raise ValueError('无法从本地分卷读取历史目录')
            found_root = False
            with machine_log.open('rb') as listing:
                for line in listing:
                    if not line.startswith(b'INFO 10 '):
                        continue
                    m = ENTRY.fullmatch(line.rstrip(b'\r\n'))
                    if not m:
                        raise ValueError('当前归档目录格式无法识别')
                    path = codecs.decode(m[1], 'unicode_escape')
                    if path == '.':
                        found_root = True
                        continue
                    relative(path)
                    parent, _, name = path.rpartition('/')
                    db.execute('INSERT INTO files VALUES(?,?,?)', (os.fsencode(parent), os.fsencode(name), m[2].decode()))
            if not found_root:
                raise ValueError('读取此版本的归档目录失败')
        os.replace(dbpath, dest)


@contextmanager
def catalog(version):
    ROOT.mkdir(exist_ok=True, mode=0o700)
    with (ROOT / 'catalog.lock').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        path = ROOT / (version + '.sqlite')
        if not path.exists():
            index_catalog(path, version)
        os.utime(path)
        db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
        # Already-open read handles survive eviction. Only generated indexes are evicted.
        for old in sorted(ROOT.glob('*.sqlite'), key=lambda p: p.stat().st_mtime, reverse=True)[2:]:
            old.unlink()
    try:
        yield db
    finally:
        db.close()


def kind_of(db, path):
    parent, _, name = path.rpartition('/')
    row = db.execute('SELECT kind FROM files WHERE parent=? AND name=?', (os.fsencode(parent), os.fsencode(name))).fetchone()
    return row[0] if row else None


def browse(db, path, offset):
    relative(path, allow_root=True)
    if path and kind_of(db, path) != 'dir':
        return {'missing': True, 'items': [], 'more': False}
    if type(offset) is not int or not 0 <= offset <= 10000000:
        raise ValueError('目录页码无效')
    rows = db.execute("SELECT name,kind FROM files WHERE parent=? ORDER BY kind='dir' DESC,name LIMIT ? OFFSET ?",
                      (os.fsencode(path), PAGE + 1, offset)).fetchall()
    return {'items': [dict(name=os.fsdecode(n), kind=k) for n, k in rows[:PAGE]], 'more': len(rows) > PAGE}


BEIJING = timezone(timedelta(hours=8))


def interval_time(day, clock, today):
    relative_days = {'今天': 0, '昨天': 1, '前天': 2}
    if day in relative_days:
        day = (today - timedelta(days=relative_days[day])).isoformat()
    if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
        raise ValueError('请输入北京时间的日期')
    if not isinstance(clock, str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d|24:00', clock):
        raise ValueError('请输入小时和分钟')
    base = datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=BEIJING)
    hour, minute = map(int, clock.split(':'))
    return int((base + timedelta(hours=hour, minutes=minute)).timestamp())


def missing_paths(before, after, directory):
    chain = cached_signatures(after['version'])
    if len(chain) >= 2 and chain[-2][0] == before['version']:
        # Direct successor signatures already contain duplicity's deleted-path records.
        with gzip.open(chain[-1][1], 'rb') as stream, tarfile.open(fileobj=stream, mode='r|') as archive:
            for entry in archive:
                archive.members.clear()
                op, _, path = entry.name.partition('/')
                if op == 'deleted' and path and (not directory or path == directory or path.startswith(directory + '/')):
                    yield relative(path)
        return
    with catalog(before['version']) as older, catalog(after['version']) as newer:
        sql = 'SELECT parent,name FROM files'
        args = ()
        if directory:
            base, _, leaf = directory.rpartition('/')
            sql += ' WHERE (parent=? AND name=?) OR parent=? OR (parent>=? AND parent<?)'
            args = tuple(os.fsencode(p) for p in (base, leaf, directory, directory+'/', directory+'0'))
        for parent, name in older.execute(sql+' ORDER BY parent,name', args):
            if not newer.execute('SELECT 1 FROM files WHERE parent=? AND name=?', (parent, name)).fetchone():
                yield os.fsdecode(parent+b'/'+name if parent else name)


def investigate(versions, data):
    today = datetime.now(BEIJING).date()
    start = interval_time(data.get('day'), data.get('fromTime'), today)
    end = interval_time(data.get('endDay', data.get('day')), data.get('untilTime'), today)
    if start >= end:
        raise ValueError('结束时间须晚于开始时间')
    directory = relative(data.get('directory', ''), allow_root=True)
    keyword = data.get('keyword', '')
    offset, index = data.get('offset', 0), data.get('intervalIndex', 0)
    if not isinstance(keyword, str) or len(keyword) > 1024 or any(type(n) is not int or n < 0 for n in (index, offset)):
        raise ValueError('筛选或分页参数无效')
    ordered = sorted(versions, key=lambda v: v['point'])
    pairs = [(a,b) for a,b in zip(ordered, ordered[1:]) if a['point'] < end and b['point'] > start]
    def stamp_label(ts):
        return datetime.fromtimestamp(ts, BEIJING).isoformat(timespec='seconds')
    result = dict(requested=[stamp_label(start), stamp_label(end)],
                  earliest=stamp_label(ordered[0]['point']) if ordered else None,
                  latest=stamp_label(ordered[-1]['point']) if ordered else None,
                  coveredStart=any(v['point'] <= start for v in ordered),
                  coveredEnd=any(v['point'] >= end for v in ordered), intervalCount=len(pairs),
                  evidence='前一恢复点存在、后一恢复点缺失。也可能是移动或改名，无法确定操作人或具体删除时间。')
    if not pairs:
        return dict(result, candidates=[], reason='没有两份覆盖所选时段的快照可供比较')
    if index >= len(pairs):
        raise ValueError('该时段没有这组相邻版本')
    before, after = pairs[index]
    candidates, counts, matched = [], Counter(), 0
    for path in missing_paths(before, after, directory):
        if keyword.casefold() not in path.casefold():
            continue
        counts[path.split('/', 1)[0] if '/' in path else '（根目录文件）'] += 1
        if offset <= matched < offset + 20:
            candidates.append(path)
        matched += 1
    return dict(result, intervalIndex=index, observed=[stamp_label(before['point']),stamp_label(after['point'])],
                restorePoint=before['point'], copies={'local':True,'google':before['google'],'baidu':before['baidu']},
                candidates=candidates, matchedEntries=matched, directoryCounts=counts.most_common(8),
                nextOffset=offset+len(candidates) if offset+len(candidates)<matched else None)


def restore_command(cmd, destination):
    # Leave the same 8 GiB reserve as the scheduled workspace capture.
    def check_space():
        if shutil.disk_usage(destination).free < 8 * 1024**3:
            raise ValueError('恢复盘剩余空间低于八 GiB，已停止本次恢复')
    check_space()
    with subprocess.Popen(cmd, env=environment(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, start_new_session=True) as proc:
        try:
            deadline = time.monotonic() + 6 * 3600
            while True:
                try:
                    return proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    check_space()
                    if time.monotonic() >= deadline:
                        raise ValueError('恢复超时')
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)


def preview(db, point, selected, source, request_id):
    if not isinstance(selected, list) or not 1 <= len(selected) <= 20 or not all(isinstance(p,str) for p in selected) or len(set(selected)) != len(selected):
        raise ValueError('每次请选择一至二十项')
    if not isinstance(request_id, str) or not re.fullmatch('[0-9a-f]{32}', request_id):
        raise ValueError('恢复请求编号无效')
    if source not in ('local', 'google', 'baidu') or (source != 'local' and not point[source]):
        raise ValueError('所选位置尚未验证此版本')
    for path in selected:
        relative(path)
        kind = kind_of(db, path)
        if kind not in ('reg', 'dir'):
            raise ValueError('请选择普通文件或目录')
        if any(path.startswith(other + '/') for other in selected):
            raise ValueError('所选项目包含重复的子目录')
        if kind == 'dir' and db.execute(
            "SELECT 1 FROM files WHERE (parent=? OR (parent>=? AND parent<?)) AND kind NOT IN ('dir','reg') LIMIT 1",
            (os.fsencode(path), os.fsencode(path + '/'), os.fsencode(path + '0'))).fetchone():
            raise ValueError('目录包含链接或特殊文件，请进入目录选择普通文件')
    return {'point': point['point'], 'paths': selected, 'source': source,
            'directory': str(ROOT / 'restored' / request_id / 'files')}


def restore(db, point, selected, source, request_id):
    preview(db, point, selected, source, request_id)
    dest_root = ROOT / 'restored'
    dest_root.mkdir(exist_ok=True)
    final = dest_root / request_id
    receipt = {'point': point['point'], 'paths': selected, 'source': source}
    with (ROOT / 'restore.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('另一个恢复任务正在运行') from None
        if final.exists():
            if read(final / 'receipt.json') != receipt:
                raise ValueError('恢复请求编号冲突')
        else:
            with tempfile.TemporaryDirectory(dir=dest_root) as tmp:
                tmp = Path(tmp)
                result = tmp / 'result'
                result.mkdir()
                for path in selected:
                    dest = result / 'files' / path
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    if source == 'local' and not (tmp / 'cache').exists():
                        seed_read_cache(tmp / 'cache')
                    if source == 'baidu':
                        cmd = [sys.executable, '-I', str(PRIVATE / 'workspace.py'), 'cloud-restore']
                        url = 'dshbaidu:///base'
                    else:
                        cmd = ['duplicity', 'restore']
                        url = REPO.as_uri() if source == 'local' else 'rclone://dsh-google:/volumes'
                    cmd += ['--archive-dir', str(tmp / 'cache'), '--time', version_time(point['version']).strftime('%Y-%m-%dT%H:%M:%SZ'),
                            '--file-to-restore', path, url, str(dest)]
                    if restore_command(cmd, dest_root) or dest.is_symlink() or not dest.exists():
                        raise ValueError('恢复失败，请核对备份副本及可用空间')
                (result / 'receipt.json').write_text(json.dumps(receipt))
                result.rename(final)
    return {'directory': str(final / 'files'), 'count': len(selected)}


def job_state(job):
    state = read(job / 'state.json')
    if state['status'] == 'running':
        with (job / 'lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return state
            state = read(job / 'state.json')
            if state['status'] == 'running':
                state.update(status='interrupted', error='恢复任务已中断，可重新选择并恢复')
    return state


def write_state(job, state):
    with tempfile.NamedTemporaryFile(mode='w', dir=job, delete=False) as f:
        json.dump(state, f)
    os.replace(f.name, job / 'state.json')


def start_job(data):
    token = data.get('requestId')
    if not isinstance(token, str) or not re.fullmatch('[0-9a-f]{32}', token):
        raise ValueError('无效的恢复请求编号')
    jobs = ROOT / 'jobs'
    jobs.mkdir(parents=True, exist_ok=True)
    job = jobs / token
    job.mkdir(exist_ok=True)
    with (job / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'submitted': True}
        if (job / 'request.json').exists() and read(job / 'request.json') != data:
            raise ValueError('恢复请求编号冲突')
        if (job / 'state.json').exists() and read(job / 'state.json')['status'] == 'done':
            return {'submitted': True}
        (job / 'request.json').write_text(json.dumps(data))
        write_state(job, dict(point=data.get('point'), source=data.get('source'), at=int(time.time()), status='running'))
        subprocess.Popen([sys.executable, '-I', __file__, 'worker', token, str(lock.fileno())],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         pass_fds=(lock.fileno(),), start_new_session=True)
    return {'submitted': True}


def worker(token, fd):
    if not re.fullmatch('[0-9a-f]{32}', token):
        raise ValueError('无效的恢复任务')
    job = ROOT / 'jobs' / token
    with os.fdopen(fd, 'a') as lock:
        state = read(job / 'state.json')
        try:
            result = handle('restore', read(job / 'request.json'))
            state.update(status='done', **result)
        except Exception as error:
            state.update(status='failed', error=str(error) if type(error) is ValueError else '恢复失败，请核对副本及空间')
        write_state(job, state)


def capture_active():
    states = subprocess.run(['systemctl', 'show', '--property=ActiveState', '--value',
                             'dsh-base-workspace-now.service', 'dsh-base-workspace-backup.service'],
                            capture_output=True, text=True)
    if states.returncode:
        return None
    return any(state in ('activating', 'active') for state in states.stdout.split())


def handle(action, data):
    if action == 'job':
        token, owner = data.get('requestId'), data.get('owner')
        if not isinstance(token,str) or not re.fullmatch('[a-f0-9]{32}', token) or not isinstance(owner,str) or not re.fullmatch('[a-f0-9]{64}', owner):
            raise ValueError('恢复任务编号或会话无效')
        job = ROOT / 'jobs' / token
        if not (job/'request.json').is_file() or read(job/'request.json').get('owner') != owner:
            raise ValueError('本会话没有此恢复任务')
        return job_state(job)
    versions = points()
    if action == 'changes':
        return investigate(versions, data)
    if action == 'capture':
        if capture_active():
            return {'submitted': False, 'active': True}
        subprocess.run(['systemctl', 'start', '--no-block', 'dsh-base-workspace-now.service'], check=True)
        return {'submitted': True}
    if action == 'points':
        jobs = sorted((ROOT / 'jobs').glob('*/state.json'), key=lambda p: p.stat().st_mtime_ns, reverse=True)
        progress = BASE / 'capture-progress.json'
        capture = read(progress) if progress.exists() else {}
        transfer = BASE / 'progress.json'
        last = BASE / 'latest.json'
        upload = read(transfer) if transfer.exists() else {}
        verified = read(last) if last.exists() else {}
        return {'baidu': {'phase': upload.get('status'), 'started': upload.get('started'),
                          'latest': verified.get('started') if verified.get('status') == 'verified' else None},
                'points': versions, 'jobs': [job_state(p.parent) for p in jobs[:6]],
                'capture': {'started': capture.get('started'), 'status': capture.get('status'),
                            'active': capture_active(), 'failedAt': capture.get('failed_at')}}
    point = next((p for p in versions if p['point'] == data.get('point')), None)
    if point is None:
        raise ValueError('恢复点不可用，请刷新版本')
    if action == 'submit':
        return start_job(data)
    with catalog(point['version']) as db:
        if action == 'preview':
            return preview(db, point, data.get('paths'), data.get('source'), data.get('requestId'))
        if action == 'browse':
            return browse(db, data.get('path'), data.get('offset', 0))
        if action == 'restore':
            return restore(db, point, data.get('paths'), data.get('source'), data.get('requestId'))
    raise ValueError('未知恢复操作')


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['warm']:
            available = points()
            if available:
                with catalog(available[0]['version']):
                    pass
            sys.exit(0)
        if len(sys.argv) == 4 and sys.argv[1] == 'worker':
            worker(sys.argv[2], int(sys.argv[3]))
            sys.exit(0)
        action, identity = sys.argv[1:]
        if (hashlib.sha256(Path('/etc/machine-id').read_bytes().strip()).hexdigest() != identity
                or (BASE / 'owner').read_text().strip() != 'DSH base workspace backup v1'):
            raise ValueError('工作区身份与登记不符')
        print(json.dumps(handle(action, json.load(sys.stdin))))
    except Exception as e:
        print(json.dumps({'error': str(e) if type(e) is ValueError else '历史版本操作失败'}))
        sys.exit(1)
