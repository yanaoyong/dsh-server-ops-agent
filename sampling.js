import { now } from './ledger.js'
import { sshInterval } from './paths.js'

export function createSampler({ collect, onSuccess, onFailure, lastSample = () => 0 }) {
  const running = new Map()
  const due = new Map()

  function sample(host) {
    if (!running.has(host.id)) {
      due.set(host.id, now() + sshInterval)
      const task = Promise.resolve().then(() => collect(host))
        .then(result => { if (result) onSuccess?.(host, result) })
        .catch(() => onFailure(host))
        .finally(() => running.delete(host.id))
      running.set(host.id, task)
    }
    return running.get(host.id)
  }

  function poll(host) {
    if (now() >= (due.get(host.id) ?? lastSample(host) + sshInterval)) return sample(host)
  }

  return { sample, poll, pending: host => running.has(host.id) }
}
