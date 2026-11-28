"""Run under python3 -I - on the registered host. Emit sanitized restore dependencies."""
import collections
import json
import os
from pathlib import Path
import shutil
import subprocess


def read(args, timeout=10):
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout)
        return result.stdout.decode(errors='replace') if result.returncode == 0 else None
    except (subprocess.TimeoutExpired, OSError):
        return None


def size(source):
    # A timeout means unknown; never extrapolate partial directory counts.
    text = read(['timeout','16','du','-sx','--block-size=1','--',source],timeout=18)
    return int(text.split()[0]) if text and text.split()[0].isdigit() else None


def db_survey(source):
    # Classify by file signature without exposing filenames under private homes.
    sample = read(['timeout','5','find',source,'-xdev','-maxdepth','4','-type','f','(',
                   '-name','*.db','-o','-name','*.sqlite','-o','-name','*.sqlite3',')','-print0'],timeout=7)
    if sample is None:
        return None
    paths = [p for p in sample.split('\0') if p]
    dbs = collections.Counter()
    for name in paths[:200]:
        try:
            with open(name,'rb') as f:
                sqlite = f.read(16) == b'SQLite format 3\x00'
            dbs['SQLite' if sqlite else 'other'] += 1
            if sqlite and Path(name+'-wal').exists():
                dbs['with_wal'] += 1
        except OSError:
            dbs['unreadable'] += 1
    return {'candidates':len(paths), 'checked':min(200,len(paths)), 'counts':dict(dbs)}


def inspect_container(name):
    text = read(['docker','inspect','--type','container',name])
    if not text:
        return {'name':name,'observed':False}
    raw = json.loads(text)[0]
    cfg, host = raw['Config'], raw['HostConfig']
    img = read(['docker','image','inspect','--format','{{.Architecture}} {{.Size}}',raw['Image']])
    mounts = [{k:m.get(k) for k in ('Type','Source','Destination','Name','RW','Propagation')} for m in raw['Mounts']]
    writable = read(['timeout','12','docker','diff',name],timeout=15)
    changes = None if writable is None else dict(collections.Counter(line[:1] for line in writable.splitlines()))
    labels = cfg.get('Labels') or {}
    return dict(name=name,observed=True,state=raw['State']['Status'],image=raw['Image'],tag=cfg['Image'],
                image_arch_size=img.strip() if img else None,restart=host['RestartPolicy']['Name'],
                mounts=mounts,networks={k:{'aliases':v.get('Aliases')} for k,v in raw['NetworkSettings']['Networks'].items()},
                published_ports=raw['NetworkSettings']['Ports'],compose_files=labels.get('com.docker.compose.project.config_files'),
                compose_service=labels.get('com.docker.compose.service'),writable_layer_counts=changes,
                env_count=len(cfg.get('Env') or []),entrypoint_present=bool(cfg.get('Entrypoint')),command_present=bool(cfg.get('Cmd')))


def main():
    rows = [inspect_container(n) for n in ('base','appnode','example-gateway','example-site')]
    mounts = sorted({m['Source'] for r in rows for m in r.get('mounts',[]) if m['Source']})
    sources = {}
    for m in mounts:
        temporary = any(x['Destination'] in ('/tmp','/var/tmp') and x['Source']==m for r in rows for x in r.get('mounts',[]))
        sources[m] = dict(is_directory=Path(m).is_dir(),bytes=None if temporary else size(m),temporary_candidate=temporary,
                          parent=next((p for p in sorted(mounts,key=len,reverse=True) if m.startswith(p.rstrip('/')+'/')),None),
                          db_signatures=None if temporary or not Path(m).is_dir() else db_survey(m))
    unit = read(['systemctl','show','appnode.service','--property=FragmentPath,ActiveState,Requires,After'])
    print(json.dumps(dict(host_arch=os.uname().machine,containers=rows,sources=sources,
                          systemd=unit.splitlines() if unit else None,free_root=shutil.disk_usage('/').free),
                     ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
