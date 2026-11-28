export const serviceProtocol = 1
export const sshCommand = '/usr/local/bin/dsh-server-ops'
export const maxRequestBytes = 1024 * 1024
export const maxResponseBytes = 16 * 1024 * 1024
export const requestTimeout = 12_000
export const serverIdPattern = /^[a-f0-9]{64}$/
export const eventIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
