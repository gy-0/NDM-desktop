#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'

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
async function readTasks() {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ port: 51874, host: '127.0.0.1' })
    let buffer = ''
    let settled = false
    socket.setEncoding('utf8')
    const finish = (error, tasks) => {
      if (settled) return
      settled = true
      socket.destroy(); error ? reject(error) : resolve(tasks)
    }
    socket.setTimeout(5000, () => finish(new Error('Cannot verify running downloads; leaving app unchanged')))
    socket.on('error', finish)
    socket.on('close', () => finish(new Error('Engine disconnected before idle status was verified')))
    socket.on('connect', () => socket.write('{"id":948201,"op":"list"}\n'))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n')
        let message
        try { message = JSON.parse(buffer.slice(0, index)) }
        catch { finish(new Error('Invalid engine response')); return }
        buffer = buffer.slice(index + 1)
        if (Array.isArray(message.tasks)) {
          finish(null, message.tasks)
          return
        }
      }
    })
  })
}
async function assertIdle() {
  const tasks = await readTasks()
  if (tasks.some((task) => ['downloading', 'starting', 'merging'].includes(task.status))) {
    throw new Error('Downloads are active; verified update is ready but installation was deferred')
  }
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
run('/usr/bin/ditto', [source, staged])
try {
  if (running()) {
    await assertIdle()
    run('/usr/bin/osascript', ['-e', 'quit app "/Applications/NDM.app"'])
    for (let i = 0; i < 15 && running(); i++) await new Promise((done) => setTimeout(done, 1000))
    if (running()) throw new Error('NDM did not exit; installed app is unchanged')
  }
  if (existsSync(destination)) renameSync(destination, backup)
  try { renameSync(staged, destination) }
  catch (error) {
    if (existsSync(backup)) renameSync(backup, destination)
    throw error
  }
  run('/usr/bin/open', [destination])
  let healthy = false
  for (let i = 0; i < 20; i++) {
    if (running()) {
      try { await readTasks(); healthy = true; break } catch { /* Allow engine startup. */ }
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  if (!healthy) throw new Error(`New app did not become ready; rollback bundle retained at ${backup}`)
  // Explicitly authorized: reclaim only this deployment's old bundle after
  // the installed app and engine are ready. Never touch the user's Trash.
  if (existsSync(backup)) rmSync(backup, { recursive: true })
  console.log(`Installed and launched NDM build ${buildNumber(destination)}; old deployment bundle permanently removed`)
} finally {
  if (existsSync(staged)) rmSync(staged, { recursive: true })
}
