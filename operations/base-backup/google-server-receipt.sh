#!/bin/bash
set -euo pipefail
umask 077
state=/var/lib/dsh-google-server
export RCLONE_CONFIG=/var/lib/dsh-workspace-private/google-drive.conf
read -r run snap < "$state/verified"
[[ "$run" =~ ^[0-9]{8}T[0-9]{6}Z$ && "$snap" =~ ^[0-9a-f]{8,64}$ ]]
# Publish a recovery point only after successful backup and checks.
receipt="$state/$run.receipt.json"
python3 -c 'import json,sys
print(json.dumps({"snapshot":sys.argv[1],"started_utc":sys.argv[2],"mode":"online-filesystems",
"repository_check":True,"full_repository_readback":sys.argv[3]=="yes",
"boot_tested":False}))' "$snap" "$run" "$([[ -s "$state/$run.read-check" ]] && echo yes || echo no)" > "$receipt"
cloud="dsh-google:server-recovery/receipts/$run-$snap.json"
rclone --config "$RCLONE_CONFIG" copyto --checksum --immutable "$receipt" "$cloud"
rclone --config "$RCLONE_CONFIG" cat "$cloud" | cmp - "$receipt"
