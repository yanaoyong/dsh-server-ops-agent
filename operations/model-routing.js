import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { atomic, audit } from './ledger.js'

const run = promisify(execFile)
const desktop = path.join(os.homedir(), '.dsh/profiles/desktop/cordis.patch.yml')
// Use the same local YAML reader as DSH routing. The UI receives only IDs and names.
const readConfig = `
rows = YAML.safe_load(File.read(ARGV[0])).reject { |r| r['disabled'] }.to_h { |r| [r['id'], r['config']] }
default = rows.fetch('agent-default-model').slice('provider','model')
providers = rows.fetch('llm-pi-ai').fetch('providers')
if ARGV[1] == 'catalog'
  result = providers.map do |id,p|
    models = Array(p['models']).select { |m| m.is_a?(Hash) && m['id'].is_a?(String) && !m['id'].empty? }
    {id:id, name:p['displayName'] || id, models:models.map { |m| m.slice('id','name') }} unless models.empty?
  end.compact
  puts JSON.generate({default:default, providers:result})
else
  route = ARGV.length == 4 ? {'provider'=>ARGV[2],'model'=>ARGV[3]} : default
  p = providers.fetch(route.fetch('provider')).dup
  p['models'] = Array(p['models']).select { |m| m['id'] == route.fetch('model') }
  raise 'unknown model' if p['models'].empty?
  puts JSON.generate([route,p])
end`

async function read(mode, selection, config = desktop) {
  const args = ['-ryaml','-rjson','-e',readConfig,config,mode]
  if (selection) args.push(selection.provider, selection.model)
  let stdout
  try { ({stdout} = await run('/usr/bin/ruby',args)) }
  catch { throw Error('无法读取 DSH 模型配置，请在模型设置中核对供应商与模型') }
  return JSON.parse(stdout.replaceAll('"false":','"off":'))
}
function saved(db) {
  return db.prepare('SELECT provider,model FROM ops_model WHERE id=1').get() ?? null
}
export async function modelCatalog(db,config) {
  return {...await read('catalog',null,config), selection:saved(db)}
}
export async function selectModel(db,selection,config) {
  if (selection !== null) {
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string')
      throw Error('请选择有效的供应商与模型')
    selection = {provider:selection.provider,model:selection.model}
    await configuredRoute(selection,config)
  }
  atomic(db,()=>{
    if (selection) db.prepare('INSERT OR REPLACE INTO ops_model VALUES(1,?,?)').run(selection.provider,selection.model)
    else db.prepare('DELETE FROM ops_model WHERE id=1').run()
    audit(db,null,'operator','选择运维调查模型',selection ?? {mode:'desktop'})
  })
  return {selection:saved(db)}
}
async function configuredRoute(selection,config) {
  const pair = await read('route',selection,config)
  if (/"(?:apiKey|secret|headers|token|authorization|password)"\s*:/i.test(JSON.stringify(pair[1])))
    throw Error('模型路由含内嵌凭据')
  return pair
}
export const investigationRoute = (db,config) => configuredRoute(saved(db),config)
