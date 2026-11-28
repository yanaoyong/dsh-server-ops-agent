import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('.', import.meta.url))
const state = mkdtempSync(path.join(tmpdir(), 'dsh-operations-test-'))
try {
  const files = readdirSync(path.join(directory, 'test'))
    .filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join('test', name))
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: directory, stdio: 'inherit',
    env: {...process.env, SERVER_OPS_STATE: state, SERVER_OPS_RECOVERY: path.join(state, 'recovery'),
      DSH_HOME: path.join(state, 'dsh')}
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(state, {recursive: true, force: true})
}
