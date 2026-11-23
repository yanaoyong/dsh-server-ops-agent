import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pkg } from './paths.js'

const programs = new Map()
function runProbe(files, args, timeout, signal) {
  const key = files.join('/')
  if (!programs.has(key)) {
    programs.set(key, files.map(name => readFileSync(path.join(pkg, name), 'utf8')).join('\n'))
  }
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-I', '-', ...args], {
      encoding: 'utf8', maxBuffer: 128 * 1024, timeout, signal
    }, (error, stdout) => {
      try {
        if (error) throw error
        resolve(JSON.parse(stdout))
      } catch {
        reject(Error('本机探针未完成'))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(programs.get(key))
  })
}

export function probeHost(host, signal) {
  return runProbe(['log-evidence.py', 'linux-probe.py'],
    ['--local', 'linux', host.machine], 45_000, signal)
}

export function readLocal(host, request, signal) {
  const body = Buffer.from(JSON.stringify({ ...request, machine: host.machine })).toString('base64')
  return runProbe(['log-evidence.py', 'retained-probe.py'], [body], 90_000, signal)
}
