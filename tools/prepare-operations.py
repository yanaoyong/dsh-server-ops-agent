"""Prepare a private site copy of the tracked operations source for a registered host."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / 'operations'


def prepare(config, output):
    if output.is_relative_to(REPO):
        raise ValueError('请选择检出目录之外的新目录')
    example = json.loads((SOURCE / 'site.example.json').read_text())
    site = json.loads(config.read_text())
    if not isinstance(site, dict) or site.keys() != example.keys():
        raise ValueError('配置字段须与 site.example.json 一致')
    patterns = {
        'host_id': r'[a-z0-9][a-z0-9-]{1,50}',
        'ssh_alias': r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}',
    }
    for key, value in site.items():
        pattern = patterns.get(key, r'[A-Za-z0-9][A-Za-z0-9_-]{0,62}')
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise ValueError(f'{key} 的格式不适用于此部署')
    if site['workspace_parent'] == site['archive_directory']:
        raise ValueError('工作区与归档需要独立目录')
    replacements = {value: site[key] for key, value in example.items()}
    names = re.compile('|'.join(map(re.escape, replacements)))
    files = subprocess.check_output(['git', 'ls-files', '-z', '--', '.'], cwd=SOURCE).split(b'\0')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    try:
        for raw in filter(None, files):
            relative = Path(os.fsdecode(raw))
            source = SOURCE / relative
            if source.is_symlink() or not source.is_file():
                raise ValueError('源码清单包含缺失文件或链接')
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(names.sub(lambda m: replacements[m[0]], source.read_text()))
            target.chmod(0o700 if source.stat().st_mode & 0o111 else 0o600)
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    prepare(args.config, args.output.resolve())
