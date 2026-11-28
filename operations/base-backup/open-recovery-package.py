"""Verify and decrypt a downloaded server recovery package into a new tar file."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def restore(manifest, key, output):
    parts = json.loads(manifest.read_text())['parts']
    if not parts or any(part['name'] != f'archive.tar.zst.gpg.part-{index:05d}'
                        or not re.fullmatch(r'[0-9a-f]{64}', part['sha256'])
                        for index, part in enumerate(parts)):
        raise ValueError('invalid package part list')
    if output.exists() or output.is_symlink():
        raise FileExistsError(output)
    paths = []
    for part in parts:
        path = manifest.parent / part['name']
        if path.is_symlink() or path.stat().st_size != part['size']:
            raise ValueError(f'part size mismatch: {path.name}')
        digest = hashlib.sha256()
        with path.open('rb') as data:
            for block in iter(lambda: data.read(1024**2), b''):
                digest.update(block)
        if digest.hexdigest() != part['sha256']:
            raise ValueError(f'part checksum mismatch: {path.name}')
        paths.append(path)

    with tempfile.NamedTemporaryFile(dir=output.parent) as tar:
        gpg = ['gpg', '--batch', '--no-tty', '--pinentry-mode', 'loopback',
               '--passphrase-file', key, '--decrypt']
        with subprocess.Popen(gpg, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as decrypted:
            with subprocess.Popen(['zstd', '-q', '-d'], stdin=decrypted.stdout, stdout=tar) as uncompressed:
                decrypted.stdout.close()
                try:
                    with decrypted.stdin:
                        for path in paths:
                            with path.open('rb') as part:
                                shutil.copyfileobj(part, decrypted.stdin)
                except BaseException:
                    decrypted.terminate()
                    uncompressed.terminate()
                    raise
            if uncompressed.returncode or decrypted.wait():
                raise RuntimeError('could not authenticate and decompress the archive')
        subprocess.run(['tar', '-tf', tar.name], stdout=subprocess.DEVNULL, check=True)
        os.link(tar.name, output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path, help='manifest.json downloaded with the encrypted parts')
    parser.add_argument('key', type=Path, help='separately stored GPG passphrase file')
    parser.add_argument('output', type=Path, help='new tar file to create')
    options = parser.parse_args()
    os.umask(0o077)
    restore(options.manifest, options.key, options.output)
