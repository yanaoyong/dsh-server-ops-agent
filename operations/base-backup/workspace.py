"""Online backup of the enrolled base workspace. All timestamps are UTC Unix seconds."""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urljoin, urlsplit

ROOT = Path('/data/dsh-workspace-archives')
SOURCE = Path('/data/example-workspace/workspace')
STAGE = ROOT/'stage'
REPO = ROOT/'volumes-v2'
CREDS = Path('/var/lib/dsh-workspace-private')
TOKEN_FILE = Path(os.environ.get('DSH_BAIDU_TOKEN_FILE', CREDS / 'baidu-access-token'))
REMOTE = 'example-host-base-workspace-v2'
WITNESS = 'README.md'
CLI = [os.environ.get('DSH_BDPAN_BIN', 'bdpan'),'--no-check-update','--config-path',str(CREDS/'bdpan.json'),'--json']
FILEMETA_BATCH = 100
FILEMETA_BACKOFF = (30, 90, 270)
os.umask(0o077)


def stamp():
    return int(time.time())


def save(path, value):
    with tempfile.NamedTemporaryFile(mode='w',dir=path.parent,delete=False) as f:
        json.dump(value,f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(f.name,path)


def digest(path,algorithm='sha256'):
    h=hashlib.new(algorithm)
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):
            h.update(block)
    return h.hexdigest()


def cloud_md5_matches(value, local_md5):
    """Baidu's listing may use a reversible text representation of an MD5."""
    if not isinstance(value,str):
        return False
    value=value.lower()
    if value==local_md5:
        return True
    if not re.fullmatch(r'[0-9a-f]{9}[g-v][0-9a-f]{22}',value):
        return False
    groups=[local_md5[i:i+8] for i in (8,0,24,16)]
    digits=[]
    for i,ch in enumerate(''.join(groups)):
        digit=int(ch,16)^(i%16)
        digits.append(chr(ord('g')+digit) if i==9 else format(digit,'x'))
    return value==''.join(digits)


def download_timeout(size):
    # A large signature file takes over an hour on the measured non-SVIP link.
    return max(1800,600+size//(24*1024))


def bd(*args, timeout=1800):
    proc=subprocess.run([*CLI,*map(str,args)],capture_output=True,timeout=timeout)
    if proc.returncode:
        raise RuntimeError('网盘操作失败 '+args[0])
    result=json.loads(proc.stdout or b'null')
    if isinstance(result,dict) and result.get('code',0) != 0:
        raise RuntimeError('网盘操作失败 '+args[0])
    return result


def baidu_access_token():
    # Managed separately from the CLI login. Reload on each request for rotation.
    with os.fdopen(os.open(TOKEN_FILE, os.O_RDONLY | os.O_NOFOLLOW), 'r') as stream:
        metadata = os.fstat(stream.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
                or metadata.st_mode & 0o077 or metadata.st_size > 8192):
            raise ValueError('需要当前用户专属的 OAuth 令牌文件')
        token = stream.read().strip()
    if not token or any(char.isspace() for char in token):
        raise ValueError('OAuth 令牌文件格式无效')
    return token


class BaiduRateLimit(RuntimeError):
    def __init__(self, status, errno, request_id, retry_after):
        message = f'百度网盘接口限流 HTTP {status} / {errno}'
        if re.fullmatch(r'[0-9]{1,30}', str(request_id)):
            message += f'，request_id={request_id}'
        super().__init__(message)
        self.retry_after = retry_after


class BaiduTransferError(RuntimeError):
    """The signed download must be retried before an object can be verified."""


def object_id(row):
    return int(row.get('fs_id', row.get('fsid')))


def retry_after_seconds(header):
    if re.fullmatch(r'[0-9]{1,9}', header):
        return int(header)
    try:
        return max(0, int(parsedate_to_datetime(header).timestamp() - time.time()) + 1)
    except (TypeError, ValueError, OverflowError):
        return 0


def baidu_json(endpoint, parameters):
    import requests
    with requests.Session() as session:
        session.headers['User-Agent'] = 'pan.baidu.com'
        for delay in (*FILEMETA_BACKOFF, None):
            try:
                with session.get('https://pan.baidu.com/rest/2.0/xpan/' + endpoint,
                                 params={**parameters, 'access_token': baidu_access_token()},
                                 timeout=(15, 60), allow_redirects=False) as response:
                    status = response.status_code
                    try:
                        info = response.json()
                    except ValueError:
                        info = {}
                    if not isinstance(info, dict):
                        raise RuntimeError('网盘元数据回执无效')
                    errno = str(info.get('errno', ''))
                    if errno in {'20012', '31034', '9013', '9019'} or status == 429:
                        retry_after = retry_after_seconds(response.headers.get('Retry-After', ''))
                        code = errno if re.fullmatch(r'[0-9]{1,9}', errno) else str(status)
                        raise BaiduRateLimit(status, code, info.get('request_id'), retry_after)
                    if status != 200 or errno != '0':
                        code = f' / {errno}' if re.fullmatch(r'-?[0-9]{1,9}', errno) else ''
                        raise RuntimeError(f'网盘元数据读取失败 HTTP {status}{code}')
                    return info
            except BaiduRateLimit as limited:
                if delay is None or limited.retry_after > FILEMETA_BACKOFF[-1]:
                    raise
                wait = max(delay, limited.retry_after)
                print(f'{limited}，{wait} 秒后重试', file=sys.stderr, flush=True)
                time.sleep(wait)
            except requests.RequestException as exc:
                error = BaiduTransferError('网盘元数据读取失败 '+type(exc).__name__)
                if delay is None:
                    raise error from None
                wait = min(delay, 30)
                print(f'{error}，{wait} 秒后重试', file=sys.stderr, flush=True)
                time.sleep(wait)


def download_links(rows, folder=None):
    """Resolve a batch of download links without putting URLs or tokens in diagnostics."""
    if folder is None:
        folder = REMOTE
    if not rows or len(rows) > FILEMETA_BATCH:
        raise ValueError('每批须包含 1 到 100 个网盘对象')
    expected = {object_id(row): (f'/apps/bdpan/{folder}/{row["server_filename"]}', row['size'])
                for row in rows}
    if len(expected) != len(rows):
        raise ValueError('网盘对象 ID 重复')
    info = baidu_json('multimedia', {'method': 'filemetas',
                                    'fsids': json.dumps(list(expected)), 'dlink': 1})
    links = {}
    entries = info.get('list')
    if not isinstance(entries, list):
        raise RuntimeError('网盘元数据缺少对象列表')
    for entry in entries:
        fsid = object_id(entry)
        if fsid not in expected or fsid in links or (entry.get('path'), entry.get('size')) != expected[fsid]:
            raise RuntimeError('网盘对象信息与目录记录不符')
        link = entry.get('dlink')
        if not isinstance(link, str):
            raise RuntimeError('网盘未返回下载链接')
        endpoint = urlsplit(link)
        if endpoint.scheme != 'https' or endpoint.netloc != 'd.pcs.baidu.com':
            raise RuntimeError('未识别的网盘下载入口')
        links[fsid] = link
    if links.keys() != expected.keys():
        raise RuntimeError('网盘未返回所有指定对象')
    return links


def download_object(row, destination, *, folder=None, link=None):
    """Fetch the listed object by ID, including files beyond bdpan's first directory page."""
    import requests
    if folder is None:
        folder = REMOTE
    size = row['size']
    # Keep the native-client preference for individual Duplicity metadata reads.
    if link is None and row['server_filename'].endswith(('.sigtar.gpg', '.manifest.gpg')):
        with tempfile.TemporaryDirectory(dir=destination.parent) as native:
            received = Path(native) / 'metadata'
            try:
                bd('download', folder+'/'+row['server_filename'], received, timeout=download_timeout(size))
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            else:
                if received.is_file() and received.stat().st_size == size:
                    received.replace(destination)
                    return
    if link is None:
        link = download_links([row], folder)[object_id(row)]
    origin = urlsplit(link)
    if origin.scheme != 'https' or origin.netloc != 'd.pcs.baidu.com':
        raise RuntimeError('未识别的网盘下载入口')
    deadline=time.monotonic()+download_timeout(size)
    with requests.Session() as session:
        session.headers['User-Agent']='pan.baidu.com'
        try:
            token = baidu_access_token()
            url = link
            for hop in range(6):
                endpoint=urlsplit(url)
                if (endpoint.scheme != 'https' or not (endpoint.hostname or '').endswith(
                        ('.baidu.com', '.baidupcs.com')) or endpoint.netloc != endpoint.hostname):
                    raise RuntimeError('未识别的网盘下载地址')
                with session.get(url,params={'access_token':token} if hop==0 else None,
                                 timeout=(15,120),allow_redirects=False,stream=True) as response:
                    if response.is_redirect:
                        url=urljoin(url,response.headers['Location'])
                        continue
                    if response.status_code!=200:
                        code = response.status_code
                        if code in {403, 408, 410, 429} or code >= 500:
                            raise BaiduTransferError(f'网盘分卷下载暂时失败 HTTP {code}')
                        raise RuntimeError(f'网盘对象下载失败 HTTP {code}')
                    with destination.open('wb') as output:
                        for chunk in response.iter_content(1024*1024):
                            if output.tell()+len(chunk)>size or time.monotonic()>deadline:
                                raise RuntimeError('网盘对象下载超出预期大小或时间')
                            output.write(chunk)
                        if output.tell()!=size:
                            raise BaiduTransferError('网盘对象下载不完整')
                    return
            raise RuntimeError('网盘下载重定向过多')
        except requests.RequestException as exc:
            # Request exceptions may contain a URL with a token or signature.
            raise BaiduTransferError('网盘对象读取失败 '+type(exc).__name__) from None


def listing(folder):
    rows={}
    start=0
    while True:
        page=bd('ls',*([folder] if folder else []),'--start',start,'--limit',500)
        if not isinstance(page,list):
            raise ValueError('无效的网盘目录回执')
        old=len(rows)
        for row in page:
            rows[row['server_filename']]=row
        if len(page)<500:
            return rows
        if len(rows)==old:
            raise ValueError('网盘分页没有前进')
        start+=len(page)


def recovery_listing(folder):
    rows = {}
    start = 0
    while True:
        page = baidu_json('file', {'method': 'list', 'dir': f'/apps/bdpan/{folder}',
                                   'start': start, 'limit': 500, 'order': 'name', 'desc': 0}).get('list')
        if not isinstance(page, list):
            raise RuntimeError('网盘目录回执无效')
        for row in page:
            name = row['server_filename']
            if name in rows:
                raise RuntimeError('网盘目录在分页期间变更，请重试')
            rows[name] = row
        if len(page) < 500:
            return rows
        start += len(page)


def fetch_verified(rows, directory, folder, *, sha256s=None, duplicity_key=None, progress=None, workers=4):
    """Keep only independently validated objects in the resumable download directory."""
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise ValueError('恢复目录不能是符号链接')
    if sha256s is None:
        sha256s = {}

    def matches(path, row):
        if path.is_symlink() or not path.is_file() or path.stat().st_size != row['size']:
            return False
        if path.name in sha256s:
            return digest(path) == sha256s[path.name]
        if cloud_md5_matches(row.get('md5'), digest(path, 'md5')):
            return True
        if duplicity_key is None or not path.name.endswith(('.manifest.gpg', '.sigtar.gpg')):
            return False
        # Legacy Duplicity metadata can have a provider MD5 that differs from its on-disk bytes.
        # GPG must authenticate the encrypted packet before the object can enter the local repository.
        result = subprocess.run(
            ['gpg', '--batch', '--no-tty', '--pinentry-mode', 'loopback', '--no-symkey-cache',
             '--status-fd', '1', '--passphrase-file', str(duplicity_key), '--output', os.devnull,
             '--decrypt', str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=download_timeout(row['size']),
        )
        return result.returncode == 0 and b'[GNUPG:] GOODMDC' in result.stdout.splitlines()

    def transfer(row, link):
        destination = directory / row['server_filename']
        with tempfile.TemporaryDirectory(prefix='.part-', dir=directory) as temp:
            partial = Path(temp) / destination.name
            download_object(row, partial, folder=folder, link=link)
            if not matches(partial, row):
                raise BaiduTransferError('下载分卷校验失败 '+destination.name)
            partial.replace(destination)

    pending = []
    for row in rows:
        name = row['server_filename']
        if Path(name).name != name or name in {'', '.', '..'}:
            raise ValueError('网盘对象名称无效')
        if not matches(directory / name, row):
            pending.append(row)
    completed = len(rows) - len(pending)
    if progress:
        progress(completed, len(rows))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for offset in range(0, len(pending), FILEMETA_BATCH):
            batch = pending[offset:offset+FILEMETA_BATCH]
            for delay in (15, 45, None):
                links = download_links(batch, folder)
                tasks = {pool.submit(transfer, row, links[object_id(row)]): row for row in batch}
                failed = []
                for task in concurrent.futures.as_completed(tasks):
                    try:
                        task.result()
                    except BaiduTransferError as error:
                        failed.append(tasks[task])
                        last_error = error
                        continue
                    completed += 1
                    if progress and (completed % 25 == 0 or completed == len(rows)):
                        progress(completed, len(rows))
                if not failed:
                    break
                if delay is None:
                    raise last_error
                print(f'{folder}: {len(failed)} 个分卷下载待重试，{delay} 秒后重取链接',
                      file=sys.stderr, flush=True)
                time.sleep(delay)
                batch = failed


def recovery_fetch(target, run_id, catalog_name, scopes=None, *, recovery_key=None):
    if (not re.fullmatch(r'[0-9]{8}-[0-9]{4}', run_id)
            or not re.fullmatch(r'status-[0-9]+\.json', catalog_name)):
        raise ValueError('恢复批次或索引文件名无效')
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.is_symlink() or target.stat().st_mode & 0o077:
        raise ValueError('恢复目录必须仅当前用户可访问')
    with (target / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        index = f'example-host-recovery-{run_id}-index'
        index_dir = target / index
        fetch_verified([recovery_listing(index)[catalog_name]], index_dir, index)
        catalog = json.loads((index_dir / catalog_name).read_text())
        if catalog.get('vps') != 'example-host' or catalog.get('run_id') != run_id:
            raise ValueError('恢复索引不属于所选服务器和批次')
        entries = {entry['scope']: entry for entry in catalog['entries']}
        if len(entries) != len(catalog['entries']):
            raise ValueError('恢复索引包含重复归档')
        if scopes is None:
            first = ('caddy', 'appnode-config', 'caddy-image', 'appnode-image')
            scopes = [scope for scope in first if scope in entries]
            scopes.extend(scope for scope in entries if scope not in {*scopes, 'base-workspace'})
            if 'base-workspace' in entries:
                scopes.append('base-workspace')
        for scope in scopes:
            entry = entries[scope]
            if not re.fullmatch(r'[a-z0-9-]+', scope) or entry.get('phase') != 'verified':
                raise ValueError('恢复索引没有已校验归档 '+scope)
            folder = REMOTE if scope == 'base-workspace' else f'example-host-recovery-{run_id}-{scope}'
            if entry.get('folder') != folder:
                raise ValueError('恢复索引目录不符 '+scope)
            directory = target / folder
            rows = recovery_listing(folder)

            def progress(done, total):
                print(f'{scope}: {done}/{total}', flush=True)

            if scope == 'base-workspace':
                cutoff = datetime.fromtimestamp(entry['verified_at'], timezone.utc).strftime('%Y%m%dT%H%M%SZ')
                selected = []
                for name, row in rows.items():
                    timestamps = re.findall(r'[0-9]{8}T[0-9]{6}Z', name)
                    if name.startswith('duplicity-') and timestamps and timestamps[-1] <= cutoff:
                        selected.append(row)
                if not selected or not any(row['server_filename'].startswith('duplicity-full.')
                                           and row['server_filename'].endswith('.manifest.gpg')
                                           for row in selected):
                    raise ValueError('恢复点没有对应的 Duplicity 全量清单')
                fetch_verified(selected, directory, folder, duplicity_key=recovery_key, progress=progress)
                continue

            fetch_verified([rows['manifest.json'], rows['verified.json']], directory, folder)
            manifest = json.loads((directory / 'manifest.json').read_text())
            receipt = json.loads((directory / 'verified.json').read_text())
            if (manifest.get('scope') != scope or manifest.get('cloud_directory') != folder
                    or receipt.get('phase') != 'verified' or receipt.get('scope') != scope
                    or receipt.get('verified_at') != entry.get('verified_at')):
                raise ValueError('归档清单或回执与索引不符 '+scope)
            parts = manifest['parts']
            if (not parts or sum(part['size'] for part in parts) != entry['bytes']
                    or any(part['name'] != f'archive.tar.zst.gpg.part-{index:05d}'
                           or not re.fullmatch(r'[0-9a-f]{64}', part['sha256'])
                           or rows[part['name']]['size'] != part['size']
                           for index, part in enumerate(parts))):
                raise ValueError('归档分卷与清单不符 '+scope)
            fetch_verified([rows[part['name']] for part in parts], directory, folder,
                           sha256s={part['name']: part['sha256'] for part in parts}, progress=progress)


def capture_databases():
    count=0
    db_bytes=0
    # Scan headers, including extensionless databases. Do not follow links into unrelated paths.
    for directory,dirs,files in os.walk(STAGE):
        for name in files:
            dest=Path(directory)/name
            try:
                st=dest.lstat()
            except FileNotFoundError:
                # A prior SQLite backup in this directory consumed its sidecars.
                if name.endswith(("-wal","-shm","-journal")):continue
                raise
            if not stat.S_ISREG(st.st_mode) or st.st_size<100:
                continue
            with dest.open('rb') as f:
                if f.read(16)!=b'SQLite format 3\x00':
                    continue
            src=SOURCE/dest.relative_to(STAGE)
            if src.resolve()!=src or not src.is_file():
                raise RuntimeError('数据库在采集时发生移动')
            with tempfile.NamedTemporaryFile(dir=dest.parent,delete=False) as f:
                temp=Path(f.name)
            try:
                with sqlite3.connect(src.as_uri()+'?mode=ro',uri=True,timeout=15) as live:
                    with sqlite3.connect(temp) as target:
                        deadline=time.monotonic()+180
                        def progress(status,left,total):
                            if time.monotonic()>deadline:raise TimeoutError('数据库在线备份超时')
                        live.backup(target,pages=512,progress=progress,sleep=.1)
                        target.execute('PRAGMA journal_mode=DELETE')
                        # Built-in SQLite page integrity works for databases using app-specific indexes too.
                        if target.execute('PRAGMA quick_check').fetchall()!=[('ok',)]:
                            raise RuntimeError('数据库副本校验失败')
                shutil.copystat(dest,temp)
                os.chown(temp,st.st_uid,st.st_gid)
                # WAL changes may leave the live main file size and mtime unchanged.
                os.utime(temp,None)
                temp.replace(dest)
                for suffix in ('-wal','-shm','-journal'):
                    Path(str(dest)+suffix).unlink(missing_ok=True)
                count+=1
                db_bytes+=dest.stat().st_size
            finally:
                temp.unlink(missing_ok=True)
    return count,db_bytes


def choose_witness():
    preferred=STAGE/WITNESS
    if preferred.resolve()==preferred and preferred.is_file():
        return WITNESS
    # Projects can be renamed; choose another actual document from this capture.
    fallback=None
    for folder,dirs,files in os.walk(STAGE):
        dirs.sort()
        for name in sorted(files):
            path=Path(folder)/name
            st=path.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_size>8*1024**2:
                continue
            if name.lower().startswith('readme'):
                return str(path.relative_to(STAGE))
            if fallback is None:
                fallback=str(path.relative_to(STAGE))
    if fallback is None:
        raise RuntimeError('没有适合单文件恢复验证的普通文件')
    return fallback


def recovery_samples(state):
    witness=state.get('witness',WITNESS)
    samples=[{'path':witness,'kind':'file','sha256':state['witness_sha256']}]
    def accept(path,kind):
        try:
            if path.resolve()!=path or not path.is_file() or path.stat().st_size>8*1024**2:
                return False
            rel=str(path.relative_to(STAGE))
            if any(s['path']==rel for s in samples):
                return False
            if kind=='sqlite':
                with path.open('rb') as f:
                    if f.read(16)!=b'SQLite format 3\x00':
                        return False
            samples.append({'path':rel,'kind':kind,'sha256':digest(path)})
            return True
        except FileNotFoundError:
            return False
    code = database = False
    for folder,dirs,files in os.walk(STAGE):
        for name in files:
            path=Path(folder)/name
            if not code and path.suffix.lower() in ('.py','.go','.js','.ts','.toml','.yaml'):
                code=accept(path,'code')
            if not database and state.get('sqlite_count'):
                database=accept(path,'sqlite')
            if code and (database or not state.get('sqlite_count')):
                return samples
    return samples


def dup(args,log):
    env={**os.environ,'PASSPHRASE':(CREDS/'duplicity.key').read_text().strip()}
    with log.open('ab') as output:
        subprocess.run(args,stdout=output,stderr=subprocess.STDOUT,env=env,check=True)


def restore_backend():
    import duplicity.backend
    class Baidu(duplicity.backend.Backend):
        def _list(self):
            self.rows=listing(REMOTE)
            return [n.encode() for n in self.rows if n.startswith('duplicity-')]
        def _get(self,filename,local):
            n=os.fsdecode(filename)
            if not re.fullmatch(r'duplicity-[0-9a-zA-Z_.-]+',n):
                raise ValueError('无效的备份分卷名称')
            destination=Path(os.fsdecode(local.name))
            with tempfile.TemporaryDirectory(dir=destination.parent) as tmp:
                received=Path(tmp)/'download'
                rows=getattr(self,'rows',None) or listing(REMOTE)
                download_object(rows[n],received)
                received.replace(destination)
    duplicity.backend.register_backend('dshbaidu',Baidu)
    sys.argv=['duplicity',*sys.argv[2:]]
    runpy.run_path('/usr/bin/duplicity',run_name='__main__')


def archive_times(name):
    return re.findall(r'(?<![0-9A-Za-z])[0-9]{8}T[0-9]{6}Z(?![0-9A-Za-z])', name)


def publish(state):
    authorized=bool(bd('whoami').get('has_valid_token'))
    save(ROOT/'cloud-authorization.json',{'authorized':authorized,'checked':stamp()})
    if not authorized:
        raise RuntimeError('VPS 网盘未登录')
    previous=listing('')
    if REMOTE not in previous:
        bd('mkdir',REMOTE)
    remote=listing(REMOTE)
    verified_dir=ROOT/'cloud-objects-v2'
    verified_dir.mkdir(exist_ok=True)
    files=sorted(p for p in REPO.iterdir() if p.is_file() and p.name.startswith('duplicity-')
                 and archive_times(p.name) and max(archive_times(p.name)) <= state['version'])
    state.update(expected_upload_bytes=sum(p.stat().st_size for p in files if p.name not in remote),
                 repository_bytes=sum(p.stat().st_size for p in files),total_objects=len(files),
                 checksum_objects=0,readback_objects=0,cached_objects=0)
    save(ROOT/'progress.json',state)

    def upload(p):
        try:
            bd('upload',p,REMOTE+'/'+p.name,timeout=download_timeout(p.stat().st_size))
        except (RuntimeError,subprocess.TimeoutExpired):
            # A lost response can follow a successful upload. Check the actual object below.
            pass

    def verify(p):
        row=remote.get(p.name)
        if not row or row.get('size')!=p.stat().st_size:
            raise RuntimeError('网盘端未确认分卷 '+p.name)
        if cloud_md5_matches(row.get('md5'),digest(p,'md5')):
            return 'checksum_objects'
        receipt=verified_dir/p.name
        fingerprint=[row.get(k) for k in ('fsid','size','md5','server_mtime')]
        sha=digest(p)
        if row.get('fsid') and row.get('md5') and receipt.exists():
            cached=json.loads(receipt.read_text())
            if cached['remote']==fingerprint and cached['sha256']==sha:
                return 'cached_objects'
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            checked=Path(tmp)/'verify'
            download_object(row,checked)
            if digest(checked)!=sha:
                raise RuntimeError('网盘分卷摘要不一致 '+p.name)
        save(receipt,{'remote':fingerprint,'sha256':sha})
        return 'readback_objects'

    # List once per batch. Listing the entire growing directory for each small volume
    # wastes requests. Publish manifests only after all their data and signatures.
    groups=[[p for p in files if 'difftar' in p.name],
            [p for p in files if 'difftar' not in p.name and 'manifest' not in p.name],
            [p for p in files if 'manifest' in p.name]]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for group in groups:
            for offset in range(0,len(group),48):
                batch=group[offset:offset+48]
                missing=[p for p in batch if p.name not in remote]
                remaining=missing
                for delay in (0,5,20):
                    if not remaining:
                        break
                    if delay:
                        time.sleep(delay)
                    list(pool.map(upload,remaining))
                    remote=listing(REMOTE)
                    remaining=[p for p in remaining if p.name not in remote]
                for kind in pool.map(verify,batch):
                    state['verified_objects']+=1
                    state[kind]+=1
                state['uploaded_bytes']+=sum(p.stat().st_size for p in missing)
                save(ROOT/'progress.json',state)
    state.update(uploaded_at=stamp(),status='restoring')
    save(ROOT/'progress.json',state)
    samples=state['recovery_samples']
    with tempfile.TemporaryDirectory(dir=ROOT) as d:
        for i,sample in enumerate(samples):
            dest=Path(d)/('sample-'+str(i))
            dup([sys.executable,'-I',__file__,'cloud-restore','--archive-dir',str(Path(d)/'archive'),
                 '--time',datetime.strptime(state['version'],'%Y%m%dT%H%M%SZ').strftime('%Y-%m-%dT%H:%M:%SZ'),'--file-to-restore',sample['path'],'dshbaidu:///base',str(dest)],ROOT/'restore.log')
            if digest(dest)!=sample['sha256']:
                raise RuntimeError('恢复文件内容与封存副本不一致')
            if sample['kind']=='sqlite':
                with sqlite3.connect(dest.as_uri()+'?mode=ro&immutable=1',uri=True) as db:
                    if db.execute('PRAGMA quick_check').fetchall()!=[('ok',)]:
                        raise RuntimeError('恢复的数据库未通过完整性检查')
            output=ROOT/'restored'/str(state['started'])/sample['path']
            output.parent.mkdir(parents=True,exist_ok=True)
            dest.replace(output)
            sample['verified_at']=stamp()
    state.update(verified_at=stamp(),status='verified',witness=samples[0]['path'])


def slot(start):
    return (start + 8*3600) // (6*3600)


def capture(force=False):
    if (ROOT/'owner').read_text().strip()!='DSH base workspace backup v1':
        raise RuntimeError('未登记备份目录')
    mounts=json.loads(subprocess.check_output(['docker','inspect','--format','{{json .Mounts}}','base']))
    if not os.path.ismount('/data') or SOURCE.resolve()!=SOURCE or not any(
        m['Type']=='bind' and m['Source']==str(SOURCE) and m['Destination']=='/workspace' for m in mounts):
        raise RuntimeError('base 工作区挂载不符')
    pending=ROOT/'pending.json'
    latest=ROOT/'latest.json'
    sealed=ROOT/'sealed'
    sealed.mkdir(exist_ok=True)
    prior=[int(p.stem) for p in sealed.glob('*.json')]
    if latest.exists():
        prior.append(json.loads(latest.read_text())['started'])
    if not pending.exists() and prior and not force and slot(max(prior)) >= slot(stamp()):
        return
    if pending.exists():
        state=json.loads(pending.read_text())
    else:
        state={'started':stamp(),'status':'capturing'}
        save(ROOT/'capture-progress.json',state)
        if shutil.disk_usage(ROOT).free < 8*1024**3:
            raise RuntimeError('暂存盘可用容量低于 8 GiB')
        for i in range(3):
            code=subprocess.run(['rsync','-aHAXx','--numeric-ids','--modify-window=-1','--delete-delay',
                                 str(SOURCE)+'/',str(STAGE)+'/'],stdout=subprocess.DEVNULL).returncode
            if code==0:break
            if code!=24 or i==2:raise RuntimeError('工作区预拷贝未完成')
        state['copied_at']=stamp()
        state['status']='databases'
        save(ROOT/'capture-progress.json',state)
        state['sqlite_count'],state['sqlite_bytes']=capture_databases()
        state['witness']=choose_witness()
        state['witness_sha256']=digest(STAGE/state['witness'])
        state['staged_at']=stamp()
        state['status']='archiving'
        save(ROOT/'capture-progress.json',state)
        save(pending,state)
    # A crash can occur after duplicity commits the manifest but before pending.json is updated.
    def committed():
        lower=time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(state['started']))
        upper=time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(state.get('packed_at') or stamp()))
        return sorted(times[-1] for p in REPO.glob('*.manifest.gpg')
                      if (times:=archive_times(p.name)) and lower <= times[-1] <= upper)
    matches=committed()
    if state['status']=='archiving' and not matches:
        state['packing_started']=stamp()
        save(ROOT/'capture-progress.json',state)
        REPO.mkdir(exist_ok=True)
        dup(['/usr/bin/duplicity','--volsize','3','--archive-dir',str(ROOT/'archive-cache-v2'),
             '--tempdir',str(ROOT/'tmp'),str(STAGE),REPO.as_uri()],ROOT/'archive.log')
        matches=committed()
    if len(matches)!=1:
        raise RuntimeError('工作区封存时间未唯一匹配')
    state.update(version=matches[0],status='sealed',cloud_directory=REMOTE,volume_mib=3)
    state.setdefault('packed_at',stamp())
    if 'recovery_samples' not in state:
        state['recovery_samples']=recovery_samples(state)
    save(sealed/(str(state['started'])+'.json'),state)
    save(ROOT/'capture-progress.json',state)
    pending.unlink()


def publish_queue():
    sealed=ROOT/'sealed'
    history=ROOT/'receipts'
    history.mkdir(exist_ok=True)
    for record in sorted(sealed.glob('*.json')):
        if (history/record.name).exists():
            continue
        publish_one(json.loads(record.read_text()),history)


def publish_one(state,history):
    state.update(upload_started=stamp(),uploaded_bytes=0,verified_objects=0)
    save(ROOT/'progress.json',state)
    publish(state)
    save(history/(str(state['started'])+'.json'),state)
    latest=ROOT/'latest.json'
    if not latest.exists() or json.loads(latest.read_text())['started'] <= state['started']:
        save(latest,state)
    save(ROOT/'progress.json',state)


if __name__=='__main__':
    if sys.argv[1:2]==['cloud-restore']:
        restore_backend()
    elif sys.argv[1:2]==['recovery-fetch']:
        import argparse
        parser = argparse.ArgumentParser(description='从百度网盘批量读取并校验恢复分卷')
        parser.add_argument('run_id')
        parser.add_argument('catalog')
        parser.add_argument('target', type=Path)
        parser.add_argument('--scope', action='append', dest='scopes')
        parser.add_argument('--token-file', type=Path, default=TOKEN_FILE)
        parser.add_argument('--recovery-key', type=Path)
        args = parser.parse_args(sys.argv[2:])
        TOKEN_FILE = args.token_file
        if args.recovery_key is not None:
            if not args.recovery_key.is_file():
                parser.error('恢复密钥文件不存在')
            if not shutil.which('gpg'):
                parser.error('使用恢复密钥验证分卷需要 gpg')
        try:
            recovery_fetch(args.target, args.run_id, args.catalog, args.scopes, recovery_key=args.recovery_key)
        except BaiduRateLimit as error:
            sys.exit(f'{error}。请在限流解除后用同一目录重新运行。')
    else:
        action=sys.argv[1] if len(sys.argv)>1 else 'both'
        if action not in ('capture','capture-now','publish','both'):
            sys.exit('未知备份操作')
        (ROOT/'tmp').mkdir(exist_ok=True)
        for phase in (('capture','publish') if action=='both' else (action,)):
            sending=phase=='publish'
            with (ROOT/('baidu-upload.lock' if sending else 'lock')).open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                try:
                    if sending:
                        publish_queue()
                    else:
                        resuming=(ROOT/'pending.json').exists()
                        capture(force=phase=='capture-now')
                        if resuming:
                            capture()
                except Exception as e:
                    progress=ROOT/('progress.json' if sending else 'capture-progress.json')
                    state=json.loads(progress.read_text()) if progress.exists() else {}
                    state.update(status='failed',failed_at=stamp(),failure_type=type(e).__name__)
                    save(progress,state)
                    raise
