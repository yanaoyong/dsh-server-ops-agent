"""Warm immutable encrypted packs from Drive for Desktop for an active restic restore."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repository', type=Path)
    parser.add_argument('priority', type=Path)
    parser.add_argument('progress', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    priority = set(json.loads(args.priority.read_text()))
    paths = [f for d in (args.repository / 'data').iterdir() for f in d.iterdir()
             if re.fullmatch('[a-f0-9]{64}', f.name)]
    paths.sort(key=lambda f: (f.name not in priority, f.name))
    started = int(time.time())
    completed = size = trees = 0

    def warm(path):
        try:
            digest = hashlib.sha256()
            n = 0
            with path.open('rb') as stream:
                while block := stream.read(1024 * 1024):
                    digest.update(block)
                    n += len(block)
            if digest.hexdigest() != path.name:
                return path, 0
            return path, n
        except OSError:
            return path, 0

    def save(failures):
        report = {'started': started, 'updated': int(time.time()), 'total': len(paths),
                  'verified_packs': completed, 'verified_bytes': size,
                  'tree_packs': trees, 'tree_total': len(priority), 'retry_pending': failures}
        tmp = args.progress.with_suffix('.tmp')
        tmp.write_text(json.dumps(report))
        tmp.replace(args.progress)

    save(0)
    from concurrent.futures import wait, FIRST_COMPLETED
    pending = paths
    for delay in (0, 30, 120):
        if not pending:
            break
        time.sleep(delay)
        retry = []
        items = iter(pending)
        with ThreadPoolExecutor(max_workers=6) as pool:
            active = {pool.submit(warm, p) for _, p in zip(range(6), items)}
            while active:
                done, active = wait(active, return_when=FIRST_COMPLETED)
                for future in done:
                    p, n = future.result()
                    if n:
                        completed += 1
                        size += n
                        trees += p.name in priority
                    else:
                        retry.append(p)
                    next_path = next(items, None)
                    if next_path is not None:
                        active.add(pool.submit(warm, next_path))
                save(len(retry))
        pending = retry
    if pending:
        raise SystemExit('Drive file reads require retry')


if __name__ == '__main__':
    main()
