#!/bin/bash
# Invoked by systemd in a private mount namespace.
set -euo pipefail
umask 077
export RCLONE_CONFIG=/var/lib/dsh-workspace-private/google-drive.conf
export RESTIC_PASSWORD_FILE=/var/lib/dsh-workspace-private/duplicity.key
export RESTIC_REPOSITORY=rclone:dsh-google:server-recovery/restic-v1
export RESTIC_CACHE_DIR=/var/cache/dsh-google-server
export RESTIC_PACK_SIZE=64
restic=/usr/local/libexec/dsh-restic-0.18.0
export GOMAXPROCS=3
state=/var/lib/dsh-google-server
view=/run/dsh-google-server-view
mkdir -p "$state" "$RESTIC_CACHE_DIR" "$view"
exec 9>"$state/lock"
flock -n 9
cd "$view"
for entry in root:/ data:/data appnode:/srv/appnode efi:/boot/efi; do
    dest=${entry%%:*}
    src=${entry#*:}
    mountpoint -q "$src"
    mkdir -p "$dest"
    mount --bind "$src" "$dest"
    mount -o remount,bind,ro "$dest"
done
mkdir -p layout
sfdisk --dump /dev/vda > layout/system.sfdisk
sfdisk --dump /dev/vdb > layout/data.sfdisk
lsblk --bytes --json -o NAME,TYPE,SIZE,FSTYPE,LABEL,UUID,PARTUUID,MOUNTPOINT > layout/disks.json
stat -c '%s %n' /swapfile /swapfile8g /var/lib/appnode/storage.ext4 > layout/recreate-files.txt
dd if=/dev/vda of=layout/system-mbr-code.bin bs=1 count=440 status=none
dd if=/dev/vda14 of=layout/bios-grub.bin bs=1M status=none
docker ps -aq | xargs -r docker inspect > layout/containers.json
systemctl cat srv-appnode.mount > layout/appnode.mount.txt
install -m 600 /usr/local/share/dsh-google-server/restore.md layout/restore.md
# Skip temporary replicas produced by the workspace backup. Its source and sealed
# local volumes remain in the snapshot. Preserve the actual mounted appnode tree.
patterns=(
    root/swapfile root/swapfile8g root/var/lib/appnode/storage.ext4
    root/var/cache/dsh-google-server root/var/lib/dsh-google-server
    'root/tmp/*' 'root/var/lib/docker/containers/*/*-json.log.tmp'
    data/dsh-workspace-archives/stage data/dsh-workspace-archives/restored
    data/dsh-workspace-archives/tmp
    'data/dsh-workspace-archives/file-history/*.sqlite'
    'data/dsh-workspace-archives/file-history/tmp*'
    'data/dsh-workspace-archives/file-history/restored/tmp*'
)
args=()
for pattern in "${patterns[@]}"; do args+=(--exclude "$pattern"); done
run=$(date -u +%Y%m%dT%H%M%SZ)
log="$state/$run.jsonl"
"$restic" backup --json --host example-host --tag google-server-online "${args[@]}" \
    root data appnode efi layout 2>"$state/$run.errors" | python3 -u -c '
import json, sys, time
last = 0
for line in sys.stdin:
    row = json.loads(line)
    now = time.monotonic()
    if row.get("message_type") == "summary" or now - last >= 60:
        print(json.dumps({k: v for k, v in row.items() if k != "current_files"}))
        last = now
' > "$log"
snap=$(python3 -c 'import json,sys
for line in open(sys.argv[1]):
    row=json.loads(line)
    if row.get("message_type")=="summary": print(row["snapshot_id"])' "$log")
[[ "$snap" =~ ^[0-9a-f]{8,64}$ ]]
"$restic" check > "$state/$run.check" 2>&1
if [[ ! -f "$state/last-full-check" || -z "$(find "$state/last-full-check" -mtime -7 -print)" ]]; then
    "$restic" check --read-data > "$state/$run.read-check" 2>&1
    touch "$state/last-full-check"
fi
for path in /root/etc/fstab /layout/system.sfdisk /layout/bios-grub.bin /layout/data.sfdisk; do
    "$restic" dump "$snap" "$path" | cmp - "${path#/}"
done
printf '%s %s\n' "$run" "$snap" > "$state/verified.tmp"
mv "$state/verified.tmp" "$state/verified"
