// A fresh local catalog and the independent recovery file exercise disaster recovery.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openLedger } from './ledger.js'
import { storage, recoverIndex, restore } from './backup.js'
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-ops-rebuild-'))
const db = openLedger(dir),
  store = await storage()
try {
  const count = await recoverIndex(db, store)
  const versions = db.prepare('SELECT * FROM versions ORDER BY ts,id').all()
  if (!versions.length) throw Error('未发现可回读的云端版本')
  const oldest = await restore(
    db,
    store,
    versions[0].id,
    path.join(dir, 'restores')
  )
  console.log(
    JSON.stringify(
      { count: count.versions, versions, oldest, temporaryCatalog: dir },
      null,
      2
    )
  )
} finally {
  db.close()
  await store.close()
}
