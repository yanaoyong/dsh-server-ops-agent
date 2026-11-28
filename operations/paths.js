import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

process.umask(0o077)
export const pkg = path.dirname(fileURLToPath(import.meta.url))
const defaultState = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library/Application Support/server-ops-agent')
  : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'server-ops-agent')
export const root =
  process.env.SERVER_OPS_STATE ||
  defaultState
export const recovery =
  process.env.SERVER_OPS_RECOVERY ||
  path.join(os.homedir(), '.config/server-ops-recovery')
export const dsh =
  process.env.DSH_BIN || (process.platform === 'darwin' ? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' : 'dsh')
export const mac = 'mac-pilot'
export const testPilot = process.env.SERVER_OPS_TEST_PILOT === '1' &&
  Boolean(process.env.SERVER_OPS_STATE) &&
  path.resolve(root) !== defaultState
export const socket = path.join(root, 'control.sock')
export function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o077)
    throw Error('需要当前用户专属目录')
}

export const sshInterval = 120
