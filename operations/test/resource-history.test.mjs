import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {appnodeHistory, resourceHistory} from '../queries.js'

test('resource history isolates host, volume and 24h window, preserving unknown and older samples', t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE workbench_hosts(id TEXT PRIMARY KEY);
    INSERT INTO workbench_hosts VALUES('example-host'),('other');
    CREATE TABLE samples(id INTEGER PRIMARY KEY,host TEXT,signal TEXT,ts INT,state TEXT,value TEXT)`)
  const insert = db.prepare('INSERT INTO samples(host,signal,ts,state,value) VALUES(?,?,?,?,?)')
  const end = 100000, start = end - 86400
  const host = 'example-host'
  const add = (signal,ts,value,state='ok',id=host) => insert.run(id,signal,ts,state,JSON.stringify(value))
  add('挂载容量 /data',start-1,{used_pct:10})
  add('挂载容量 /data',end+1,{used_pct:90})
  add('挂载容量 /data',end,{used_pct:80,available_bytes:0},'bad')
  add('挂载容量 /data',start,{used_pct:0})
  add('挂载容量 /data',start+10,{},'unknown')
  add('挂载容量 /srv/appnode',end,{used_pct:23,available_bytes:123})
  add('主机容量',start,{root_used_pct:30,available_memory_pct:0,load15:0})
  add('主机容量',end,{root_used_pct:85,available_bytes:24,load15:4.12},'bad')
  add('挂载容量 /data',end,{used_pct:99},'ok','other')
  add('挂载容量 /data',end,{used_pct:66},'ok','retired')
  const query = resource => resourceHistory(db,host,resource,end)
  assert.equal(query('/data').start,start)
  assert.equal(query('/data').end,end)
  assert.deepEqual(query('/data').rows.map(row=>[row.state,row.pct,row.bytes]),[
    ['ok',0,null],['unknown',null,null],['bad',80,0]])
  assert.deepEqual(query('/').rows.map(row=>[row.pct,row.memory,row.load,row.bytes]),[
    [30,0,0,null],[85,null,4.12,24]])
  assert.deepEqual(query('/srv/appnode'),appnodeHistory(db,host,end))
  assert.deepEqual(query('/srv/appnode').rows.map(row=>[row.pct,row.bytes]),[[23,123]])
  assert.deepEqual(resourceHistory(db,'retired','/data',end).rows,[])
  assert.throws(()=>query('unrecognized'),/未知的资源历史/)
})
