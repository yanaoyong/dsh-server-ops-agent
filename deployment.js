import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const repository = 'https://github.com/yanaoyong/dsh-server-ops-agent'
const metadata = new URL('./generated/linux-release.json', import.meta.url)
const asset = new URL('./generated/linux-release.tgz', import.meta.url)
const lifetime = 5 * 60_000

const check = `if [ "$(uname -s)" != Linux ]; then exit 21; fi
case "$(uname -m)" in aarch64|x86_64) ;; *) exit 21;; esac
[ "$(cat /proc/1/comm)" = systemd ] || exit 21
`

const deploy = `set -eu
[ "$3" != probe ] || exit 0
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
if [ "$3" = install ]; then
  scratch=$(mktemp -d /tmp/dsh-server-ops.XXXXXXXX)
  trap 'rm -rf -- "$scratch"' EXIT
  trap 'exit 1' HUP INT TERM
  head -c "$(($2 + 1))" > "$scratch/release.tgz"
  printf '%s  %s\\n' "$1" "$scratch/release.tgz" | sha256sum -c --status || exit 23
  tar -xzf "$scratch/release.tgz" -C "$scratch"
  sh "$scratch/install-linux.sh" install >/dev/null || exit 24
fi
if [ -n "\${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  usermod -aG server-ops-read -- "$SUDO_USER" || exit 25
fi
`

function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function rootCommand(digest, bytes, mode) {
  const command = '/bin/sh -c ' + quote(deploy) + ' dsh-release ' + digest + ' ' + bytes + ' ' + mode
  return 'if [ "$(id -u)" = 0 ]; then ' + command + '; else sudo -n ' + command + '; fi'
}

async function release() {
  const { version, digest, bytes } = JSON.parse(await readFile(metadata, 'utf8'))
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  if (version !== manifest.version || !/^[0-9a-f]{64}$/.test(digest) ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1024 * 1024)
    throw Error('插件内的 Linux 发行包元数据无效')
  return { version, digest, bytes }
}

export async function deployOffer(client, config, pending, grantOnly) {
  const { version, digest, bytes } = await release()
  const probe = check + rootCommand(digest, bytes, 'probe') + ' || exit 22'
  const { code } = await client.run(probe, '', 12_000, 1024)
  if (code !== 0 && code !== 22) throw Error('请使用运行 systemd 的 Linux x64 或 ARM64 服务器')
  const tag = 'v' + version
  const filename = 'server-ops-agent-linux-' + version + '.tgz'
  const install = {
    host: config.host, port: config.port, user: config.user, version, grantOnly,
    releaseUrl: repository + '/releases/tag/' + tag,
    instructions: [
      ...(grantOnly ? [] : [
        "printf '%s  %s\\n' " + digest + ' ' + filename + ' | sha256sum -c -',
        'mkdir -p server-ops-install && tar -xzf ' + filename + ' -C server-ops-install',
        'sudo sh server-ops-install/install-linux.sh install',
      ]),
      'sudo usermod -aG server-ops-read -- ' + quote(config.user)
    ].join('\n')
  }
  if (code === 0) {
    const now = Date.now()
    for (const [id, offer] of pending) {
      if (offer.expires <= now || JSON.stringify(offer.config) === JSON.stringify(config)) pending.delete(id)
    }
    if (pending.size >= 32) pending.delete(pending.keys().next().value)
    install.confirmation = randomUUID()
    pending.set(install.confirmation, { expires: now + lifetime, config, grantOnly })
  }
  return { install }
}

export async function deployRelease(client, grantOnly) {
  const { digest, bytes } = await release()
  const archive = grantOnly ? '' : await readFile(asset)
  if (!grantOnly && (archive.length !== bytes || createHash('sha256').update(archive).digest('hex') !== digest))
    throw Error('插件内的 Linux 发行包校验失败')
  const { code } = await client.run(rootCommand(digest, bytes, grantOnly ? 'grant' : 'install'),
    archive, 240_000, 4096)
  if (code === 23) throw Error('服务器收到的安装包校验失败')
  if (code === 24) throw Error('Linux 安装失败，请检查依赖和 systemd 服务日志')
  if (code === 25) throw Error('服务已安装，请让管理员将 SSH 用户加入读取组')
  if (code !== 0) throw Error('SSH 账号需要 root 或非交互 sudo 权限')
}
