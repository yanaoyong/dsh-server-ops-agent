import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
await mkdir('generated', {recursive:true})
const result = await build({
  entryPoints: ['ssh2'], outfile: 'generated/ssh-client.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  legalComments: 'inline', metafile: true,
  external: ['cpu-features', '*.node']
})
const packages = new Set(Object.keys(result.metafile.inputs)
  .map(name => name.match(/^node_modules\/([^/]+)\//)?.[1]).filter(Boolean))
const notices = []
for (const name of [...packages].sort()) {
  const license = new URL('LICENSE', pathToFileURL(require.resolve(name + '/package.json')))
  notices.push(name + '\n' + await readFile(license, 'utf8'))
}
await writeFile('generated/ssh-licenses.txt', notices.join('\n\n'))
