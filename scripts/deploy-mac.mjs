#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDeployRPC } from './deploy-mac-rpc.mjs'
import { createPauseSession, installWithRecovery } from './deploy-mac-lifecycle.mjs'

if (process.platform !== 'darwin') throw new Error('deploy-app requires macOS')
const source = resolve(`dist/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/NDM.app`)
const destination = '/Applications/NDM.app'
const staged = `/Applications/.NDM-update-${randomUUID()}.app`
const backup = `/Applications/.NDM-backup-${randomUUID()}.app`
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ''}`)
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}
const running = () => spawnSync('/usr/bin/pgrep', ['-f', '^/Applications/NDM.app/']).status === 0
const callEngine = createDeployRPC()
function rpc(op, fields = {}, timeout = 5000) {
  if (op === 'pause' || op === 'resume') console.log(`Update: ${op} task ${fields.taskID}`)
  return callEngine(op, fields, timeout)
}
const delay = ms => new Promise(done => setTimeout(done, ms))
async function quit() {
  run('/usr/bin/osascript', ['-e', 'quit app "/Applications/NDM.app"'])
  for (let i = 0; i < 15 && running(); i++) await delay(1000)
  if (running()) throw new Error('NDM did not exit; no force quit or bundle swap performed')
}
async function healthy() {
  for (let i = 0; i < 20; i++) {
    if (running()) {
      try { const reply = await rpc('list'); if (reply.ok === true && Array.isArray(reply.tasks)) return true }
      catch { /* Allow engine startup. */ }
    }
    await delay(500)
  }
  return false
}
function buildNumber(bundle) {
  return run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', `${bundle}/Contents/Info.plist`], true).trim()
}

// Build and verify before asking the existing app to exit. Never force-kill a
// download or remove the installed bundle while a build can still fail.
if (!process.argv.includes('--skip-build')) run('npm', ['run', 'package'])
if (!existsSync(source)) throw new Error(`Missing package: ${source}`)
const incomingBuild = Number(buildNumber(source))
const installedBuild = existsSync(destination) ? Number(buildNumber(destination)) : 0
if (!Number.isSafeInteger(incomingBuild) || !Number.isSafeInteger(installedBuild) || incomingBuild <= 0) {
  throw new Error('NDM requires numeric, monotonically increasing build numbers')
}
if (incomingBuild <= installedBuild) {
  throw new Error('Build number must increase. Run npm run version:next, then rebuild before installing.')
}
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source])
if (!run('/usr/bin/codesign', ['-d', '-r-', source], true).includes('anchor apple')) {
  throw new Error('Local deployment requires stable Apple signing; refusing an ad-hoc privacy-identity reset')
}
const session = createPauseSession({ rpc })
let installedNew = false
try {
  run('/usr/bin/ditto', [source, staged])
  await installWithRecovery({
    session, running, quit, healthy,
    swap() {
      if (existsSync(destination)) renameSync(destination, backup)
      renameSync(staged, destination)
      installedNew = true
    },
    launch() { run('/usr/bin/open', [destination]) },
    rollback() {
      if (existsSync(backup)) {
        if (installedNew && existsSync(destination)) renameSync(destination, staged)
        renameSync(backup, destination)
        installedNew = false
      } else if (installedNew) {
        throw new Error(`No previous bundle to restore; new bundle retained at ${destination}`)
      }
    },
    cleanupBackup() {
      // Reclaim only this deployment's old bundle after health and selective
      // task recovery succeeded. Never touch the user's Trash.
      if (existsSync(backup)) rmSync(backup, { recursive: true })
    }
  })
  console.log(`Installed and launched NDM build ${buildNumber(destination)}; selective recovery verified for this update's paused task IDs [${[...session.pausedIDs].join(', ')}]; old deployment bundle permanently removed`)
} catch (error) {
  if (existsSync(backup)) console.error(`Previous deployment retained at ${backup}`)
  throw error
} finally {
  if (existsSync(staged)) rmSync(staged, { recursive: true })
}
