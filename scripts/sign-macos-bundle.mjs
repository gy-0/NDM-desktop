import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const defaultOutputDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
const appPath = resolve(process.argv[2] ?? `dist/${defaultOutputDirectory}/NDM.app`)
if (process.platform !== 'darwin') throw new Error('macOS bundle signing must run on macOS')
if (!existsSync(appPath)) throw new Error(`NDM app bundle not found: ${appPath}`)

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ''}`)
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

// Ad-hoc designated requirements contain a build's cdhash. TCC therefore sees
// changed builds as different applications. Local installs use a real identity;
// unsigned CI artifacts require explicit opt-in and are not deployment defaults.
let identity = process.env.NDM_SIGNING_IDENTITY?.trim()
if (!identity) {
  const listing = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], true)
  const identities = [...listing.matchAll(/\b([A-Fa-f0-9]{40}) "(Apple Development:|Developer ID Application:)[^"]+"/g)]
  if (identities.length === 1) identity = identities[0][1]
  else if (process.env.NDM_ALLOW_ADHOC_SIGNING === '1' && identities.length === 0) identity = '-'
  else throw new Error('Set NDM_SIGNING_IDENTITY to a stable Apple signing identity. Ad-hoc CI builds require NDM_ALLOW_ADHOC_SIGNING=1.')
}
if (identity === '-' && process.env.NDM_ALLOW_ADHOC_SIGNING !== '1') {
  throw new Error('Ad-hoc signing changes privacy identity on rebuild; explicit NDM_ALLOW_ADHOC_SIGNING=1 is required.')
}

// Resource executables are not guaranteed to be traversed by codesign --deep.
const host = join(appPath, 'Contents/Resources/bin/NDMHost')
if (!existsSync(host)) throw new Error('Packaged NDMHost missing')
run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp=none',
  '--identifier', 'com.neatdownloadmanager.ndm.host', host])
run('/usr/bin/codesign', ['--force', '--deep', '--sign', identity, '--timestamp=none', appPath])
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
for (const target of [appPath, host]) {
  const requirement = run('/usr/bin/codesign', ['-d', '-r-', target], true)
  if (identity !== '-' && !requirement.includes('anchor apple')) {
    throw new Error(`Stable Apple designated requirement missing: ${target}`)
  }
  console.log(requirement.trim())
}
console.log(`Verified ${identity === '-' ? 'explicit ad-hoc CI' : 'stable Apple'} signature: ${appPath}`)
