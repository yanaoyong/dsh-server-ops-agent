#!/bin/sh
set -eu
src=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
destination=${1:?请指定 Linux 安装包的输出路径}
python3 - "$src" "$destination" <<'PY'
import gzip
from pathlib import Path
import sys
import tarfile

source = Path(sys.argv[1])
names = (source / 'linux-runtime.files').read_text(encoding='utf-8').splitlines()
names += ['install-linux.sh', 'linux-runtime.files', 'server-ops-agent.service',
          'dsh-server-ops', 'DSH-Linux-首次连接.md', 'LICENSE']

with open(sys.argv[2], 'wb') as destination:
    with gzip.GzipFile(filename='', fileobj=destination, mode='wb', mtime=0) as stream:
        with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for name in sorted(names):
                path = source / name
                if Path(name).name != name or path.is_symlink() or not path.is_file():
                    raise ValueError(f'Invalid Linux release file: {name}')
                entry = tarfile.TarInfo(name)
                entry.size = path.stat().st_size
                entry.mode = 0o755 if name in {'dsh-server-ops', 'install-linux.sh'} else 0o644
                with path.open('rb') as body:
                    archive.addfile(entry, body)
PY
