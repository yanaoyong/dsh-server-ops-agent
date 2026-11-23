import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

process.umask(0o077)
export const pkg = path.dirname(fileURLToPath(import.meta.url))
export const root = process.env.SERVER_OPS_STATE || '/var/lib/server-ops-agent'
export function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o077)
    throw Error('需要当前用户专属目录')
}

export const sshInterval = 120
