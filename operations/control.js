import fs from 'node:fs'
import { setLimits } from './signals.js'
import { openLedger, now } from './ledger.js'
import { register, setBackupSchedule } from './backup.js'
import { mac, testPilot } from './paths.js'
import { fault } from './fixture.js'
import { collectHost, linkContainerEntry, validAlias } from './ssh.js'
const [action, id, alias] = process.argv.slice(2)
const db = openLedger()
switch (action) {
  case 'init':
    await register(db)
    break
  case 'fault':
    if (!testPilot) throw Error('仅限隔离试点')
    fault(db)
    break
  case 'inspect-ssh':
  case 'register-ssh':
    if (id === mac || typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,50}$/.test(id) || !validAlias(alias))
      throw Error('需要稳定主机 ID 和已验证的 SSH 别名')
    {
      if (!await collectHost(db, { id, alias })) throw Error('SSH 主机核验失败')
      if (action === 'register-ssh')
        db.prepare('INSERT OR IGNORE INTO enrolled VALUES(?)').run(id)
      break
    }
  case 'link-container-ssh':
    linkContainerEntry(db, id, alias, process.argv[5])
    break
  case 'record-inventory': {
    if (!db.prepare('SELECT 1 FROM identities WHERE host=?').get(id))
      throw Error('需要先核实该主机的 SSH 身份')
    const data = JSON.parse(fs.readFileSync(alias, 'utf8'))
    const names = new Set(data.containers?.map(c => c.name))
    if (
      !['base', 'appnode', 'example-gateway', 'example-site'].every(name => names.has(name)) ||
      data.host_arch !== 'x86_64' ||
      !Array.isArray(data.containers) ||
      data.containers.length !== 4
    )
      throw Error('主机盘点格式无效')
    db.prepare('INSERT OR REPLACE INTO inventories VALUES(?,?,?)').run(
      id,
      now(),
      JSON.stringify(data)
    )
    break
  }
  case 'set-limits':
    setLimits(db, id, JSON.parse(alias))
    break
  case 'stop-ssh':
    db.prepare('DELETE FROM enrolled WHERE host=?').run(id)
    break
  case 'stop-pilot-backup':
    setBackupSchedule(db, false)
    break
  case 'schedule-pilot':
    if (!testPilot) throw Error('仅限隔离试点')
    setBackupSchedule(db, true)
    break
  default:
    throw Error('支持 init / fault / register-ssh ID Alias / schedule-pilot')
}
db.close()
