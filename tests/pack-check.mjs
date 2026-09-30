/**
 * Publish-readiness check: what would actually leave this machine if the package
 * were published, and does the manifest promise only things that are inside it.
 *
 * Runs `npm pack --dry-run --json`, so it is offline and writes nothing.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const raw = execFileSync(npm, ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
const [entry] = JSON.parse(raw)
const files = entry.files.map((f) => f.path.replace(/\\/g, '/'))
const manifestText = readFileSync(join(ROOT, 'package.json'), 'utf8')
// A BOM is legal UTF-8 but breaks JSON.parse for every other tool. npm tolerates
// it, so nothing else would have caught it — and this bit us once, through a
// PowerShell `Set-Content -Encoding UTF8` round trip on this very file.
const manifest = JSON.parse(manifestText.replace(/^\uFEFF/, ''))
check('package.json has no byte-order mark', !manifestText.startsWith('\uFEFF'))

console.log(`packing ${manifest.name}@${manifest.version}: ${files.length} files, ${(entry.size / 1024).toFixed(1)} KiB\n`)

const required = [
  'package.json', 'cordis.patch.yml', 'README.md', 'README.zh-CN.md', 'LICENSE',
  'lib/host.js', 'lib/client.js', 'lib/engine.js', 'lib/launch.js', 'lib/recipe.js',
  'lib/recipes/opencode.json', 'lib/recipes/claude.json',
  'fixtures/claude-result.json', 'fixtures/opencode-result.jsonl',
]
for (const file of required) {
  check(`ships ${file}`, files.includes(file), files.includes(file) ? '' : 'MISSING')
}

const forbidden = files.filter((f) => f.startsWith('tests/') || f.includes('node_modules/') || f.startsWith('.'))
check('ships no tests, no node_modules, no dotfiles', forbidden.length === 0, forbidden.join(', ') || 'clean')

// The manifest's promises must point at files that are really inside the tarball.
const clientExport = manifest.exports?.['./client']
const clientFile = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('exports["./client"] exists in the tarball',
  Boolean(clientFile) && files.includes(clientFile.replace(/^\.\//, '')), `${clientFile}`)
const patch = manifest.dsh?.bundle?.patch
check('dsh.bundle.patch exists in the tarball',
  Boolean(patch) && files.includes(patch.replace(/^\.\//, '')), `${patch}`)
check('the host entry declared as "main" is shipped',
  files.includes(String(manifest.main || '').replace(/^\.\//, '')), manifest.main)

// Install-time lifecycle hooks would run on a stranger's machine; there must be none.
check('declares no install-time lifecycle hooks',
  !['preinstall', 'install', 'postinstall', 'prepare', 'prepack'].some((hook) => manifest.scripts && manifest.scripts[hook]),
  JSON.stringify(manifest.scripts || {}))

check('the package name is a publishable slug', /^[a-z0-9][a-z0-9._-]*$/.test(manifest.name), manifest.name)
check('the license is declared', Boolean(manifest.license), manifest.license)
check('the DSH client platform is declared', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client))
check('there are no runtime dependencies to audit', !manifest.dependencies || Object.keys(manifest.dependencies).length === 0,
  JSON.stringify(manifest.dependencies || {}))

console.log(`\n${failures === 0 ? 'PACK CHECK: PASS' : `PACK CHECK: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
