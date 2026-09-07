#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
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
async function assertIdle() {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ port: 51874, host: '127.0.0.1' })
    let buffer = ''
    let settled = false
    socket.setEncoding('utf8')
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy(); error ? reject(error) : resolve()
    }
    socket.setTimeout(5000, () => finish(new Error('Cannot verify running downloads; leaving app unchanged')))
    socket.on('error', finish)
    socket.on('close', () => finish(new Error('Engine disconnected before idle status was verified')))
    socket.on('connect', () => socket.write('{"id":948201,"op":"list"}\n'))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n')
        const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
        if (Array.isArray(message.tasks)) {
          const active = message.tasks.some((task) => ['downloading', 'starting', 'merging'].includes(task.status))
          finish(active ? new Error('Downloads are active; verified update is ready but installation was deferred') : null)
          return
        }
      }
    })
  })
}

// Build and verify before asking the existing app to exit. Never force-kill a
// download or remove the installed bundle while a build can still fail.
if (!process.argv.includes('--skip-build')) run('npm', ['run', 'package'])
if (!existsSync(source)) throw new Error(`Missing package: ${source}`)
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
  // Keep the replacement at the canonical path before trashing the old bundle.
  if (existsSync(backup)) run('/usr/bin/trash', [backup])
  run('/usr/bin/open', [destination])
  console.log('Installed and launched verified NDM with stable signing')
} finally {
  if (existsSync(staged)) run('/usr/bin/trash', [staged])
}
