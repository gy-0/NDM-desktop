import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const defaultOutputDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
const appPath = resolve(process.argv[2] ?? `dist/${defaultOutputDirectory}/NDM.app`)

if (process.platform !== 'darwin') {
  throw new Error('macOS bundle signing must run on macOS')
}

if (!existsSync(appPath)) {
  throw new Error(`NDM app bundle not found: ${appPath}`)
}

function runCodesign(args) {
  const result = spawnSync('/usr/bin/codesign', args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`codesign exited with status ${result.status}`)
  }
}

// electron-builder intentionally skips signing while mac.identity is null.
// Re-sign the complete bundle so Electron's nested frameworks and the outer
// resource seal agree, producing a structurally valid local Beta candidate.
runCodesign(['--force', '--deep', '--sign', '-', '--timestamp=none', appPath])
runCodesign(['--verify', '--deep', '--strict', '--verbose=4', appPath])

console.log(`Verified local ad-hoc signature: ${appPath}`)
