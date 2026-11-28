import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID
} from 'node:crypto'
import { spawn } from 'node:child_process'
import { root, recovery, privateDir, mac } from './paths.js'
import { atomic, hash, now, observe, audit } from './ledger.js'

const binary = path.join(os.homedir(), '.local/bin/bdpan')
const source = path.join(root, 'pilot-files')
const cfg = path.join(root, 'baidu.json')
const retained = path.join(
  os.homedir(),
  '.dsh/ops-control/baidu-archive/bdpan.json'
)
const keyfile = path.join(recovery, 'mac-pilot.json')
const hex = /^[0-9a-f]{64}$/
const maxBytes = 32 * 1024 * 1024
const commandTimeout = 90_000
const maxTransferTime = 30 * 60_000
function bd(args, { input, own = false, uploadBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const download = args[0] === 'download'
    const timeout = download ? maxTransferTime
      : Math.min(maxTransferTime, commandTimeout + Math.ceil(uploadBytes / 32768) * 1000)
    const child = spawn(
      binary,
      [
        '--config-path',
        own || existsSync(cfg) || !existsSync(retained) ? cfg : retained,
        '--no-check-update',
        '--json',
        ...args
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], timeout }
    )
    if (download) {
      // bdpan grows <destination>.part and renames it when the transfer completes.
      let previousSize = 0
      let changed = performance.now()
      const monitor = setInterval(async () => {
        const part = await fs.stat(args[2] + '.part').catch(() => null)
        if (part && part.size !== previousSize) {
          changed = performance.now()
          previousSize = part.size
        } else if (performance.now() - changed > commandTimeout) {
          child.kill()
        }
      }, 5000)
      monitor.unref()
      child.once('close', () => clearInterval(monitor))
    }
    const chunks = []
    let length = 0
    child.stdout.on('data', (chunk) => {
      length += chunk.length
      if (length > 8 * 1024 * 1024) child.kill()
      else chunks.push(chunk)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.on('error', () => reject(Error('无法启动 bdpan')))
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(Error('百度网盘 ' + args[0] + ' 失败'))
    )
  })
}
export async function auth(action, code) {
  if (action === 'authorize') {
    const reply = JSON.parse(
      await bd(['login', '--accept-disclaimer', '--get-auth-url'], {
        own: true
      })
    )
    for (const v of strings(reply)) {
      if (
        typeof v === 'string' &&
        /^https:\/\/openapi\.baidu\.com\/oauth\/2\.0\/authorize\?/.test(v)
      )
        return { url: v }
    }
    throw Error('百度授权入口不可用')
  }
  if (action === 'finish-login') {
    if (!/^[\w.-]{1,512}$/.test(code)) throw Error('授权码格式无效')
    await bd(['login', '--set-code-stdin'], { own: true, input: code + '\n' })
  }
  const v = JSON.parse(await bd(['whoami']))
  return { authorized: Boolean(v.authenticated && v.has_valid_token) }
}
export async function checkAuthorization(db, lookup = () => auth('auth')) {
  let result
  try {
    result = await lookup()
  } catch {
    observe(db, mac, '网盘授权', 'unknown', { reason: '暂时无法读取授权状态' })
    throw Error('暂时无法读取授权状态')
  }
  observe(db, mac, '网盘授权', result.authorized ? 'ok' : 'bad', {
    authorized: result.authorized,
    source: 'bdpan whoami'
  })
  return result
}
function* strings(v) {
  if (typeof v === 'string') yield v
  else if (v && typeof v === 'object')
    for (const item of Object.values(v)) yield* strings(item)
}
export async function register(db) {
  const pilot = db.prepare('SELECT 1 FROM workbench_hosts WHERE id=?').get(mac)
  const initialized = db
    .prepare("SELECT 1 FROM audit WHERE kind='Mac 试点登记' LIMIT 1")
    .get()
  const priorVersions = db.prepare('SELECT 1 FROM versions UNION ALL SELECT 1 FROM group_versions LIMIT 1').get()
  if ((initialized || priorVersions) && !existsSync(keyfile))
    throw Error('请从独立保管位置取回试点恢复材料')
  if (initialized || priorVersions) return
  privateDir(recovery)
  if (!existsSync(keyfile)) {
    await fs.writeFile(
      keyfile,
      JSON.stringify({
        schema: 1,
        prefix: 'soa-' + randomBytes(9).toString('hex'),
        key: randomBytes(32).toString('hex')
      }),
      { flag: 'wx', mode: 0o600 }
    )
  }
  if (!pilot) return
  privateDir(source)
  for (const [name, content] of Object.entries({
    'keep.txt': 'unchanged\n',
    'edit.txt': 'revision one\n',
    'recover.txt': 'recover this file\n'
  })) {
    await fs
      .writeFile(path.join(source, name), content, { flag: 'wx' })
      .catch((e) => {
        if (e.code !== 'EEXIST') throw e
      })
  }
  audit(db, null, 'operator', 'Mac 试点登记', { source })
}
function encrypt(key, bytes) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}
function decrypt(key, bytes) {
  const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  d.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([d.update(bytes.subarray(28)), d.final()])
}
export async function storage({ onTransfer } = {}) {
  const { key, prefix } = JSON.parse(await fs.readFile(keyfile))
  if (!hex.test(key) || !/^soa-[a-f0-9]{18}$/.test(prefix))
    throw Error('恢复材料格式有误')
  const secret = Buffer.from(key, 'hex')
  const dir = await fs.mkdtemp(path.join(root, 'cloud-'))
  const filename = (kind, id) => {
    if (!['version', 'pack', 'group'].includes(kind) || !hex.test(id))
      throw Error('对象编号无效')
    return prefix + '-' + kind + '-' + id + '.bin'
  }
  async function read(kind, id) {
    const name = filename(kind, id)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const local = path.join(dir, randomUUID() + '.bin')
      try {
        const started = performance.now()
        await bd(['download', name, local])
        const duration_ms = Math.round(performance.now() - started)
        const bytes = await fs.readFile(local)
        if (hash(bytes) !== id) throw Error('云端摘要不符')
        const data = JSON.parse(decrypt(secret, bytes))
        onTransfer?.({ operation: 'download', kind, bytes: bytes.length, duration_ms, attempt })
        return data
      } catch (e) {
        if (attempt === 3) throw e
      }
    }
  }
  return {
    read,
    async write(kind, obj, verifiedPacks) {
      const bytes = encrypt(secret, Buffer.from(JSON.stringify(obj)))
      const id = hash(bytes),
        name = filename(kind, id),
        file = path.join(dir, name)
      await fs.writeFile(file, bytes)
      const started = performance.now()
      let acknowledged = true
      try {
        await bd(['upload', file, name], { uploadBytes: bytes.length })
      } catch {
        acknowledged = false // Readback reconciles an uncertain upload.
      }
      onTransfer?.({ operation: 'upload', kind, bytes: bytes.length,
        duration_ms: Math.round(performance.now() - started), acknowledged })
      const remote = await read(kind, id)
      if (kind === 'pack' && verifiedPacks) verifiedPacks.set(id, remote)
      return id
    },
    async list(kind = 'version') {
      if (!['group','version'].includes(kind)) throw Error('无效清单类型')
      const ids = new Set()
      for (let start = 0; ; start += 500) {
        const data = JSON.parse(
          await bd(['ls', '--start', String(start), '--limit', '500'])
        )
        const matches = [...strings(data)]
        for (const s of matches) {
          const m = path.posix
            .basename(s)
            .match(new RegExp('^' + prefix + '-' + kind + '-([a-f0-9]{64})\\.bin$'))
          if (m) ids.add(m[1])
        }
        const arrays = []
        function traverse(n) {
          if (Array.isArray(n)) arrays.push(n)
          else if (n && typeof n === 'object')
            Object.values(n).forEach(traverse)
        }
        traverse(data)
        if (!arrays.some((a) => a.length >= 500)) break
      }
      return [...ids]
    },
    close: () => fs.rm(dir, { force: true, recursive: true })
  }
}
function safe(name) {
  if (
    typeof name !== 'string' ||
    name
      .split('/')
      .some((p) => !p || p === '..' || p === '.' || p.includes('\0'))
  )
    throw Error('清单含无效路径')
}
export async function snapshot(dir) {
  const files = [],
    dirs = [],
    objects = new Map()
  if (!(await fs.lstat(dir)).isDirectory())
    throw Error('登记源目录类型发生变化')
  const canonical = await fs.realpath(dir)
  const metadata = Object.create(null)
  const observed = new Map()
  const fingerprint = (s) =>
    [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join('/')
  let size = 0
  async function walk(rel) {
    const folder = path.join(dir, rel)
    if ((await fs.realpath(folder)) !== path.join(canonical, rel))
      throw Error('目录越出登记范围')
    const folderStat = await fs.lstat(folder)
    metadata[rel] = { mode: folderStat.mode & 0o777, uid: folderStat.uid, gid: folderStat.gid }
    observed.set(folder, fingerprint(folderStat))
    for (const item of (
      await fs.readdir(path.join(dir, rel), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(rel, item.name)
      safe(name)
      if (item.isDirectory()) {
        dirs.push(name)
        await walk(name)
        continue
      }
      if (!item.isFile()) throw Error('试点范围仅登记普通文件和目录')
      const file = path.join(dir, name),
        handle = await fs.open(
          file,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        )
      try {
        const before = await handle.stat()
        size += before.size
        if (size > maxBytes) throw Error('超过 Mac 试点的 32 MiB 登记范围')
        const bytes = await handle.readFile(),
          sha = hash(bytes),
          after = await handle.stat()
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
          throw Error('采集期间文件已变化')
        observed.set(file, fingerprint(before))
        files.push({ name, sha, mode: before.mode & 0o777 })
        metadata[name] = { mode: before.mode & 0o777, uid: before.uid, gid: before.gid }
        objects.set(sha, bytes.toString('base64'))
      } finally {
        await handle.close()
      }
    }
  }
  await walk('')
  for (const [entry, before] of observed) {
    if (fingerprint(await fs.lstat(entry)) !== before)
      throw Error('扫描期间源目录发生变化')
  }
  return { dirs, files, objects, metadata }
}
async function verify(store, manifest, packs = new Map()) {
  if (
    manifest.schema !== 1 ||
    manifest.host !== mac ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.dirs)
  )
    throw Error('版本清单无效')
  for (const d of manifest.dirs) safe(d)
  for (const f of manifest.files) {
    safe(f.name)
    if (!hex.test(f.pack) || !hex.test(f.sha)) throw Error('文件引用无效')
    if (!packs.has(f.pack)) packs.set(f.pack, await store.read('pack', f.pack))
    const content = packs.get(f.pack)[f.sha]
    if (
      typeof content !== 'string' ||
      hash(Buffer.from(content, 'base64')) !== f.sha
    )
      throw Error('文件回读摘要不符')
  }
  return packs
}
export function setBackupSchedule(db, enabled, ts = now()) {
  if (typeof enabled !== 'boolean') throw Error('请选择启用或停用定时备份')
  return atomic(db, () => {
    const change = enabled
      ? db.prepare('INSERT OR IGNORE INTO schedule(host,due) VALUES(?,?)').run(mac, ts + 86400)
      : db.prepare('DELETE FROM schedule WHERE host=?').run(mac)
    const policy = db.prepare('SELECT due FROM schedule WHERE host=?').get(mac) ?? null
    if (change.changes) audit(db, null, 'operator', enabled ? '启用每日备份' : '停用每日备份',
      { host: mac, due: policy?.due ?? null }, ts)
    return policy
  })
}
export function recordBackupFreshness(db, policy, ts = now()) {
  const last = db.prepare('SELECT MAX(ts) AS ts FROM versions WHERE host=?').get(mac).ts
  let expected = last === null ? policy.due : last + 86400
  if (last === null) {
    // Older ledgers may have a scheduler claim but no explicit enrollment receipt.
    const first = db.prepare(
      `SELECT COALESCE(json_extract(detail,'$.first'),json_extract(detail,'$.due')) AS due FROM audit
       WHERE kind IN ('启用每日备份','合并到期备份') AND json_extract(detail,'$.host')=?
       AND seq>COALESCE((SELECT MAX(seq) FROM audit WHERE kind='停用每日备份' AND json_extract(detail,'$.host')=?),0)
       ORDER BY seq LIMIT 1`
    ).get(mac, mac)
    expected = first?.due ?? policy.due
  }
  const state = ts > expected + 1800 ? 'bad' : last === null ? 'unknown' : 'ok'
  return observe(db, mac, '备份时效', state, { last, expected, grace_seconds: 1800 }, ts)
}
export function claimBackup(db, ts = now(), scheduled = false) {
  return atomic(db, () => {
    if (db.prepare("SELECT 1 FROM backups WHERE status='interrupted' LIMIT 1").get())
      throw Error('上一次备份正在核对云端回执')
    const job = randomUUID()
    if (scheduled) {
      const policy = db
        .prepare('SELECT due FROM schedule WHERE host=?')
        .get(mac)
      if (!policy || policy.due > ts) return null
      const missed = Math.floor((ts - policy.due) / 86400)
      audit(
        db,
        null,
        'scheduler',
        '合并到期备份',
        {
          host: mac,
          job,
          first: policy.due,
          last: policy.due + missed * 86400,
          missed
        },
        ts
      )
      db.prepare('UPDATE schedule SET due=? WHERE host=?').run(
        policy.due + (missed + 1) * 86400,
        mac
      )
    }
    db.prepare(
      "INSERT INTO backups(id,ts,status,stage) VALUES(?,?,'running','扫描已登记目录')"
    ).run(job, ts)
    return job
  })
}
export function failBackup(db, job, reason) {
  const row = db
    .prepare(
      "UPDATE backups SET status='failed',finished=?,detail=? WHERE id=? AND status IN ('running','interrupted') RETURNING id"
    )
    .get(now(), reason, job)
  if (row) observe(db, mac, '网盘备份', 'bad', { job, reason })
}
export async function backup(db, store, dir = source, job = claimBackup(db)) {
  let publishing = false
  const { ts } = db.prepare('SELECT ts FROM backups WHERE id=?').get(job)
  const stage = (s) =>
    db.prepare('UPDATE backups SET stage=? WHERE id=?').run(s, job)
  try {
    const { dirs, files, objects } = await snapshot(dir)
    const previous = db
      .prepare(
        'SELECT id FROM versions WHERE host=? ORDER BY ts DESC,rowid DESC LIMIT 1'
      )
      .get(mac)
    const refs = new Map()
    if (previous) {
      const old = await store.read('version', previous.id)
      for (const f of old.files) refs.set(f.sha, f.pack)
    }
    const fresh = Object.fromEntries(
      [...objects].filter(([sha]) => !refs.has(sha))
    )
    const added = Object.keys(fresh).length
    const verifiedPacks = new Map()
    stage('加密上传并回读数据包')
    if (added) {
      const id = await store.write('pack', fresh, verifiedPacks)
      for (const sha of Object.keys(fresh)) refs.set(sha, id)
    }
    const manifest = {
      schema: 1,
      ts,
      job,
      host: mac,
      dirs,
      files: files.map((f) => ({ ...f, pack: refs.get(f.sha) }))
    }
    manifest.added = added
    manifest.reused = objects.size - added
    stage('验证当前版本全部引用')
    await verify(store, manifest, verifiedPacks)
    stage('发布并回读加密清单')
    publishing = true
    const version = await store.write('version', manifest),
      reused = objects.size - added
    atomic(db, () => {
      db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(
        version,
        mac,
        ts,
        files.length
      )
      db.prepare(
        "UPDATE backups SET status='verified',finished=?,stage='云端回读通过',version=?,added=?,reused=? WHERE id=?"
      ).run(now(), version, added, reused, job)
    })
    observe(db, mac, '网盘备份', 'ok', { job, version, added, reused })
    return { job, version, added, reused }
  } catch (e) {
    if (publishing) {
      db.prepare("UPDATE backups SET status='interrupted',stage='等待核对云端清单' WHERE id=? AND status='running'").run(job)
    } else {
      failBackup(db, job, e.message)
    }
    throw e
  }
}
export async function recoverIndex(db, store) {
  const ids = await store.list()
  for (const id of ids) {
    const m = await store.read('version', id)
    await verify(store, m)
    atomic(db, () => {
      const checked = now()
      db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?)').run(
        id, m.host, m.ts, m.files.length
      )
      db.prepare(
        "INSERT OR IGNORE INTO backups(id,ts,finished,status,stage,version) VALUES(?,?,?,'reindexed','云端版本与引用对象复核通过',?)"
      ).run('index-' + id + '-' + checked, checked, checked, id)
    })
  }
  return { versions: ids.length }
}
export async function restore(
  db,
  store,
  id,
  parent = path.join(root, 'restores'),
  selected = null
) {
  if (
    !hex.test(id) ||
    !db.prepare('SELECT 1 FROM versions WHERE id=? AND host=?').get(id, mac)
  )
    throw Error('请选择已核验的版本')
  const m = await store.read('version', id),
    packs = await verify(store, m)
  if (selected !== null) {
    safe(selected)
    m.files = m.files.filter((f) => f.name === selected)
    if (m.files.length !== 1) throw Error('指定文件不在此版本中')
    m.dirs = m.dirs.filter((d) => selected.startsWith(d + '/'))
  }
  privateDir(parent)
  const tmp = await fs.mkdtemp(path.join(parent, '.partial-'))
  try {
    for (const d of m.dirs)
      await fs.mkdir(path.join(tmp, d), { recursive: true })
    for (const f of m.files) {
      const dest = path.join(tmp, f.name)
      await fs.writeFile(
        dest,
        Buffer.from(packs.get(f.pack)[f.sha], 'base64'),
        { flag: 'wx', mode: f.mode }
      )
      await fs.chmod(dest, f.mode & 0o777)
      if (hash(await fs.readFile(dest)) !== f.sha)
        throw Error('恢复文件校验失败')
    }
    const dest = path.join(parent, 'restore-' + randomUUID())
    await fs.mkdir(dest, { mode: 0o700 })
    try {
      await fs.rename(tmp, dest)
    } catch (e) {
      await fs.rmdir(dest)
      throw e
    }
    const detail = {
      dest,
      files: m.files.map(({ name, sha }) => ({ name, sha }))
    }
    db.prepare(
      "INSERT INTO backups(id,ts,finished,status,stage,version,detail) VALUES(?,?,?,'restored','恢复文件摘要通过',?,?)"
    ).run(randomUUID(), now(), now(), id, JSON.stringify(detail))
    return detail
  } finally {
    await fs.rm(tmp, { force: true, recursive: true })
  }
}

export async function reconcileBackups(db, store) {
  const pending = new Set(
    db
      .prepare("SELECT id FROM backups WHERE status='interrupted'")
      .all()
      .map((r) => r.id)
  )
  if (!pending.size) return
  for (const version of await store.list()) {
    const m = await store.read('version', version)
    if (!pending.has(m.job)) continue
    await verify(store, m)
    atomic(db, () => {
      db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?)').run(
        version,
        mac,
        m.ts,
        m.files.length
      )
      db.prepare(
        "UPDATE backups SET status='verified',stage='中断后云端对账通过',finished=?,version=?,added=?,reused=? WHERE id=?"
      ).run(now(), version, m.added ?? null, m.reused ?? null, m.job)
    })
    observe(db, mac, '网盘备份', 'ok', { job:m.job, version, reconciled:true })
    pending.delete(m.job)
  }
  for (const job of pending) failBackup(db, job, '云端对账未发现已发布版本')
}
