"""Restore a Google server snapshot into two newly created disk images on isolated Linux."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

os.umask(0o077)


def run(*args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, **kwargs)


def read_json(*args):
    return json.loads(run(*args, stdout=subprocess.PIPE).stdout)


def attach(stack, image, offset=0, length=None):
    args = ['losetup', '--find', '--show', '--offset', str(offset)]
    if length is not None:
        args += ['--sizelimit', str(length)]
    dev = run(*args, image, stdout=subprocess.PIPE, text=True).stdout.strip()
    stack.callback(run, 'losetup', '-d', dev)
    return dev


def mount(stack, dev, mountpoint):
    mountpoint.mkdir(parents=True, exist_ok=True)
    run('mount', dev, mountpoint)
    stack.callback(run, 'umount', mountpoint)


def make_disk(work, layout, dump_name, old, names, resume):
    disk = work / (dump_name + '.img')
    if resume:
        if disk.is_symlink() or not disk.is_file() or disk.stat().st_size != names[old]['size']:
            raise ValueError('unexpected rehearsal disk image')
    else:
        with disk.open('xb') as out:
            out.truncate(names[old]['size'])
        table = (layout / (dump_name + '.sfdisk')).read_text()
        table = table.replace('/dev/' + old, str(disk))
        run('sfdisk', disk, input=table.encode(), stdout=subprocess.DEVNULL)
    parts = read_json('sfdisk', '--json', disk)['partitiontable']
    sector = parts['sectorsize']
    offsets = {int(p['node'][len(str(disk)):]): (p['start'] * sector, p['size'] * sector)
               for p in parts['partitions']}
    return disk, offsets


def guest_probe(root):
    # Only installed into the newly restored throwaway disk.
    script = root / 'usr/local/sbin/dsh-isolated-recovery-probe'
    script.write_text("""#!/bin/bash
exec > /dev/ttyS0 2>&1
echo DSH_RESTORED_KERNEL_STARTED
failed=0
for path in / /data /boot/efi /srv/appnode; do mountpoint -q "$path" || failed=1; done
test -s /etc/fstab && test -d /data/example-workspace/workspace && test -d /srv/appnode/workspace || failed=1
for i in $(seq 1 60); do
    ready=1
    for c in base appnode example-gateway example-site dsh-nightwarden dsh-nightwarden-metrics; do
        status=$(timeout 8 docker inspect -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)
        case "$status" in 'true '| 'true healthy') ;; *) ready=0 ;; esac
    done
    [ "$ready" = 1 ] && break
    sleep 10
done
[ "$ready" = 1 ] || failed=1
for c in base appnode example-gateway example-site dsh-nightwarden dsh-nightwarden-metrics; do
    printf 'DSH_CONTAINER %s ' "$c"
    timeout 8 docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || true
done
curl -fsS -o /dev/null --max-time 20 http://127.0.0.1:3080/ || failed=1
timeout 240 env LD_LIBRARY_PATH=/data/dsh-server-recovery/sqlite-3.54.1 python3 - <<'DB' || failed=1
import json, sqlite3
from pathlib import Path

def check(p):
    with sqlite3.connect(p.resolve().as_uri()+'?mode=ro', uri=True, timeout=20) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('SQLite quick check failed')

workspace = Path('/data/example-workspace/workspace')
receipt = json.loads(Path('/data/dsh-workspace-archives/latest.json').read_bytes())
samples = receipt['recovery_samples']
for sample in samples:
    f = workspace / sample['path']
    if not f.is_file() or not f.stat().st_size:
        raise RuntimeError('missing workspace sample')
    if sample['kind'] == 'sqlite':
        check(f)
if not any(item['kind'] == 'sqlite' for item in samples):
    raise RuntimeError('missing SQLite sample in workspace receipt')
print('DSH_BASE_WORKSPACE_SAMPLES_OK')
home = Path('/srv/appnode/home')
checked = 0
for parent in (home/'.local/share/example-app', home/'.cc-switch', home/'.openclaw/state'):
    if not parent.is_dir():
        continue
    for f in parent.rglob('*'):
        if f.is_file() and not f.is_symlink() and 100 <= f.stat().st_size <= 256*1024**2:
            with f.open('rb') as stream:
                header = stream.read(16)
            if header == bytes.fromhex('53514c69746520666f726d6174203300'):
                check(f)
                checked += 1
                break
if not checked:
    raise RuntimeError('missing appnode database sample')
print('DSH_APPNODE_SQLITE_OK', checked)
DB
if [ "$failed" = 0 ]; then echo DSH_ISOLATED_RESTORE_PASS; else echo DSH_ISOLATED_RESTORE_FAIL; fi
sync
systemctl --no-block poweroff
""")
    script.chmod(0o700)
    units = root / 'etc/systemd/system'
    unit = units / 'dsh-isolated-recovery-probe.service'
    unit.write_text("""[Unit]
Description=Isolated restored disk startup probe
After=local-fs.target docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/dsh-isolated-recovery-probe
TimeoutStartSec=30min
[Install]
WantedBy=multi-user.target
""")
    (units / 'multi-user.target.wants').mkdir(exist_ok=True)
    (units / 'multi-user.target.wants' / unit.name).symlink_to('../' + unit.name)


def rehearse(snapshot, work, resume=False):
    if resume and not re.fullmatch(re.escape(snapshot) + r"-[0-9]+", work.name):
        raise ValueError("recovery directory does not match snapshot")
    work.mkdir(mode=0o700, parents=True, exist_ok=resume)
    work = work.resolve()
    dest = work / 'tree'
    dest.mkdir(exist_ok=resume)
    restic = ['restic', '--no-lock', 'restore', snapshot, '--target', dest]
    run(*restic, '--include', '/layout')
    layout = dest / 'layout'
    devices = read_json('cat', layout / 'disks.json')['blockdevices']
    names = {x['name']: x for x in devices}
    for device in devices:
        names.update({x['name']: x for x in device.get('children', [])})
    system, system_parts = make_disk(work, layout, 'system', 'vda', names, resume)
    data, data_parts = make_disk(work, layout, 'data', 'vdb', names, resume)
    swap_and_loop = {p: int(n) for n, p in (line.split() for line in
                     (layout / 'recreate-files.txt').read_text().splitlines())}
    with system.open('r+b') as disk:
        mbr = (layout / 'system-mbr-code.bin').read_bytes()
        bios = (layout / 'bios-grub.bin').read_bytes()
        if len(mbr) != 440 or len(bios) != system_parts[14][1]:
            raise ValueError('BIOS boot-region size mismatch')
        disk.write(mbr)
        disk.seek(system_parts[14][0])
        disk.write(bios)
    with contextlib.ExitStack() as stack:
        for short, backing, part, info in (
            ('root', system, system_parts[1], names['vda1']),
            ('data', data, data_parts[1], names['vdb1']),
            ('efi', system, system_parts[15], names['vda15']),
        ):
            dev = attach(stack, backing, *part)
            if resume:
                actual = run('blkid', '-s', 'UUID', '-o', 'value', dev, stdout=subprocess.PIPE, text=True)
                if actual.stdout.strip().lower() != info['uuid'].lower():
                    raise ValueError('existing recovery partition UUID mismatch')
            elif short == 'efi':
                run('mkfs.vfat', '-F', '32', '-n', info['label'], '-i', info['uuid'].replace('-', ''), dev)
            else:
                run('mkfs.ext4', '-q', '-F', '-O', '^orphan_file,^metadata_csum_seed',
                    '-U', info['uuid'], '-L', info['label'] or '', dev)
            mount(stack, dev, work / 'fat' if short == 'efi' else dest / short)
        loop_path = '/var/lib/appnode/storage.ext4'
        loop_file = dest / 'root' / loop_path.lstrip('/')
        loop_file.parent.mkdir(parents=True, exist_ok=True)
        if resume:
            if loop_file.is_symlink() or loop_file.stat().st_size != swap_and_loop[loop_path]:
                raise ValueError('unexpected appnode image')
        else:
            with loop_file.open('xb') as disk:
                disk.truncate(swap_and_loop[loop_path])
        dev = attach(stack, loop_file)
        info, = (d for d in devices if d.get('label') == 'appnode-data')
        if resume:
            actual = run('blkid', '-s', 'UUID', '-o', 'value', dev, stdout=subprocess.PIPE, text=True)
            if actual.stdout.strip() != info['uuid']:
                raise ValueError('existing appnode UUID mismatch')
        else:
            run('mkfs.ext4', '-q', '-F', '-O', '^orphan_file,^metadata_csum_seed',
                '-U', info['uuid'], '-L', info['label'], dev)
        mount(stack, dev, dest / 'appnode')
        run(*restic, '--verify')
        # FAT exposes synthesized POSIX permissions. Restore into Linux staging,
        # then check every EFI byte against the FAT copy.
        for entry in (dest / 'efi').iterdir():
            target = work / 'fat' / entry.name
            if entry.is_dir():
                shutil.copytree(entry, target, copy_function=shutil.copyfile)
            else:
                shutil.copyfile(entry, target)
        run('diff', '-qr', dest / 'efi', work / 'fat')
        for path in ('/swapfile', '/swapfile8g'):
            swap = dest / 'root' / path.lstrip('/')
            run('fallocate', '-l', swap_and_loop[path], swap)
            swap.chmod(0o600)
            run('mkswap', swap, stdout=subprocess.DEVNULL)
        guest_probe(dest / 'root')
        os.sync()
    log = work / 'serial.private.log'
    with log.open('wb') as out:
        run('timeout', '80m', 'qemu-system-x86_64', '-machine', 'pc,accel=tcg', '-cpu', 'max',
            '-smp', '4', '-m', '6144', '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
            '-no-reboot', '-nic', 'none', '-drive', f'file={system},format=raw,if=virtio',
            '-drive', f'file={data},format=raw,if=virtio', stdout=out, stderr=subprocess.STDOUT)
    serial = log.read_bytes().splitlines()
    passed = any(line.strip() == b'DSH_ISOLATED_RESTORE_PASS' for line in serial)
    receipt = {'snapshot': snapshot, 'finished': int(time.time()), 'restic_restore_verify': True,
               'network': 'none', 'boot_and_services_passed': passed,
               'base_workspace_samples_checked': any(b'DSH_BASE_WORKSPACE_SAMPLES_OK' in l for l in serial),
               'appnode_sqlite_checked': any(b'DSH_APPNODE_SQLITE_OK' in l for l in serial)}
    (work / 'result.json').write_text(json.dumps(receipt) + '\n')
    if not passed:
        raise RuntimeError('isolated guest startup probe did not pass')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot')
    parser.add_argument('new_directory', type=Path)
    parser.add_argument('--resume', action='store_true', help='reuse existing isolated filesystem images')
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{8,64}', args.snapshot):
        parser.error('snapshot must be a specific ID')
    rehearse(args.snapshot, args.new_directory, args.resume)
