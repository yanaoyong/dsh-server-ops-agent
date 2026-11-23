#!/bin/sh
set -eu

if [ "$(id -u)" != 0 ]; then
  echo '请用 root 执行 Linux 服务安装命令' >&2
  exit 1
fi

unit=server-ops-agent.service
unit_path=/etc/systemd/system/$unit
entry=/usr/local/bin/dsh-server-ops
base=/opt/server-ops-agent
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
install -d -m 0755 "$base/releases"
exec 9>"$base/install.lock"
flock -x 9

case "${1:-}" in
  start) systemctl enable --now "$unit"; exit ;;
  stop) systemctl disable --now "$unit"; exit ;;
  install|upgrade) ;;
  *) echo '用法: sh install-linux.sh install|upgrade|start|stop' >&2; exit 2 ;;
esac

source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s):$(uname -m)" in
  Linux:aarch64) arch=arm64 ;;
  Linux:x86_64) arch=x64 ;;
  *) echo '仅支持 Linux ARM64 和 x64' >&2; exit 1 ;;
esac
for tool in python3 systemctl ss tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "缺少 Linux 依赖: $tool" >&2; exit 1; }
done

old=$(readlink "$base/current" || true)
if [ "$1" = upgrade ] && [ -z "$old" ]; then
  echo '请先安装 Linux 运维服务' >&2
  exit 1
fi

getent group server-ops-read >/dev/null || groupadd --system server-ops-read
id server-ops >/dev/null 2>&1 || useradd --system --gid server-ops-read --home-dir /var/lib/server-ops-agent --shell /usr/sbin/nologin server-ops
install -d -o server-ops -g server-ops-read -m 0700 /var/lib/server-ops-agent

release=$(mktemp -d "$base/releases/release.XXXXXXXX")
transaction=$(mktemp -d "$base/upgrade.XXXXXXXX")
was_active=false
was_enabled=false
touched=false
committed=false
enable_attempted=false
if systemctl is-active --quiet "$unit"; then was_active=true; fi
if systemctl is-enabled --quiet "$unit" 2>/dev/null; then was_enabled=true; fi

switch_release() {
  rm -f "$transaction/current-link" &&
    ln -s "$1" "$transaction/current-link" &&
    mv -Tf "$transaction/current-link" "$base/current"
}

replace_file() {
  from=$1 to=$2
  scratch=$(mktemp -d "$(dirname "$to")/.server-ops.XXXXXXXX") || return 1
  if cp -a -- "$from" "$scratch/file" && mv -Tf "$scratch/file" "$to"; then
    rmdir "$scratch"
  else
    rm -rf -- "$scratch"
    return 1
  fi
}

restore_file() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    replace_file "$1" "$2"
  else
    rm -f -- "$2"
  fi
}

version_of() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$1/package.json"
}

compatible_node() {
  "$1" --input-type=module -e "
    import {DatabaseSync} from 'node:sqlite';
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 13)) process.exit(1);
    new DatabaseSync(':memory:').close();
  " >/dev/null 2>&1
}

select_node() {
  system_node=$(command -v node || true)
  if [ -n "$system_node" ] && compatible_node "$system_node"; then
    printf '%s\n' "$system_node"
    return
  fi

  version=22.23.5
  case "$arch" in
    arm64) digest=2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09 ;;
    x64) digest=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8 ;;
  esac
  name=node-v$version-linux-$arch
  runtime="$base/runtime/$name"
  if ! compatible_node "$runtime/bin/node"; then
    archive="$source_dir/$name.tar.xz"
    if [ ! -f "$archive" ]; then
      command -v curl >/dev/null || { echo '缺少 curl，或请在安装目录准备离线 Node 运行时' >&2; return 1; }
      archive="$transaction/$name.tar.xz"
      curl --fail --silent --show-error --location --proto '=https' --max-time 120 \
        -o "$archive" "https://nodejs.org/dist/v$version/$name.tar.xz" || return 1
    fi
    printf '%s  %s\n' "$digest" "$archive" | sha256sum -c --status ||
      { echo 'Node 运行时 SHA-256 校验失败' >&2; return 1; }
    tar -xJf "$archive" --no-same-owner -C "$transaction" || return 1
    compatible_node "$transaction/$name/bin/node" ||
      { echo '此 Linux 无法运行发行版 Node，请检查 glibc' >&2; return 1; }
    install -d -m 0755 "$base/runtime" || return 1
    mv -T "$transaction/$name" "$runtime" || return 1
  fi
  printf '%s\n' "$runtime/bin/node"
}

ready() {
  expected=$1
  n=0
  while [ "$n" -lt 30 ]; do
    if systemctl is-active --quiet "$unit" &&
      printf '%s\n' '{"action":"service-info"}' | "$entry" | python3 -c '
import json, re, sys
try:
    info = json.load(sys.stdin)
    ready = info.get("version") == sys.argv[1] and re.fullmatch(r"[a-f0-9]{64}", info.get("serverId", ""))
except (ValueError, AttributeError, TypeError):
    ready = False
sys.exit(not ready)
' "$expected"; then
      return 0
    fi
    n=$((n + 1))
    sleep 1
  done
  return 1
}

rollback() {
  # A malformed new unit may fail to stop or disable until its files are restored.
  systemctl stop "$unit" || true
  if "$enable_attempted"; then systemctl disable "$unit" || true; fi
  if [ -n "$old" ]; then switch_release "$old" || return 1
  else rm -f "$base/current" || return 1
  fi
  restore_file "$transaction/old-unit" "$unit_path" || return 1
  restore_file "$transaction/old-entry" "$entry" || return 1
  systemctl daemon-reload || return 1
  if "$was_enabled"; then systemctl enable "$unit" || return 1
  elif "$enable_attempted" && [ -n "$old" ]; then systemctl disable "$unit" || return 1
  fi
  if "$was_active"; then
    systemctl reset-failed "$unit" 2>/dev/null || true
    systemctl restart "$unit" && ready "$old_version"
  elif [ -e "$unit_path" ]; then
    systemctl stop "$unit"
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if "$touched" && ! "$committed"; then
    status=1
    if rollback; then
      echo 'Linux 运维服务安装失败，已恢复安装前的配置和服务状态' >&2
    else
      echo "Linux 运维服务回滚未通过，请检查 systemd 日志和备份目录 $transaction" >&2
      exit 1
    fi
  fi
  if ! "$committed"; then rm -rf -- "$release"; fi
  rm -rf -- "$transaction"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

expected_version=$(version_of "$source_dir")
if [ -n "$old" ] && [ "$1" = install ]; then
  if [ "$(version_of "$old")" != "$expected_version" ]; then
    echo '已安装其他版本，请用 upgrade 并确认升级版本' >&2
    exit 1
  fi
  if ! ready "$expected_version"; then
    systemctl restart "$unit"
    ready "$expected_version"
  fi
  systemctl enable "$unit"
  echo 'Linux 运维服务已就绪'
  exit
fi

node_bin=$(select_node)
ln -s "$node_bin" "$release/node"

while IFS= read -r file; do
  install -m 0644 "$source_dir/$file" "$release/$file"
done < "$source_dir/linux-runtime.files"
install -m 0644 "$source_dir/$unit" "$release/$unit"
install -m 0755 "$source_dir/dsh-server-ops" "$release/dsh-server-ops"
chmod 0755 "$release"
old_version=''
if "$was_active" && [ -n "$old" ]; then old_version=$(version_of "$old"); fi
if [ -e "$unit_path" ] || [ -L "$unit_path" ]; then cp -a -- "$unit_path" "$transaction/old-unit"; fi
if [ -e "$entry" ] || [ -L "$entry" ]; then cp -a -- "$entry" "$transaction/old-entry"; fi

touched=true
replace_file "$release/$unit" "$unit_path"
replace_file "$release/dsh-server-ops" "$entry"
switch_release "$release"
systemctl daemon-reload
systemctl restart "$unit"
ready "$expected_version"
enable_attempted=true
systemctl enable "$unit"
committed=true
echo 'Linux 运维服务已启动'
