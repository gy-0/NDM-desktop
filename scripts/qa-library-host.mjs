// Real isolated Host + Electron large-library UI.
// No browser profile, public media, cookies or production app resources are read.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ui
const binary = process.argv[2]
if (!binary) throw new Error('Pass an isolated NDMHost binary.')
const root = await mkdtemp(join(tmpdir(), 'ndm-library-ui-'))
const support = join(root, 'support'), downloads = join(root, 'downloads')
await mkdir(support); await mkdir(downloads)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, predicate) => { for (let n = 0; n < 150; n++) { const result = await predicate(); if (result) return result; await delay(50) } throw new Error(`Timed out: ${label}`) }
const freePort = async () => { const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const hostPort = await freePort(), bridgePort = await freePort()
let host = spawn(binary, [], { env: { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
let exited = once(host, 'exit')
let seq = 0
const request = (op, extra = {}) => new Promise((resolve, reject) => {
  const id = ++seq, socket = createConnection({ host: '127.0.0.1', port: hostPort })
  const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Host ${op} timeout`)) }, 12000)
  let buffer = ''
  socket.on('error', error => { clearTimeout(timer); reject(error) })
  socket.on('connect', () => socket.write(JSON.stringify({ ...extra, op, id }) + '\n'))
  socket.on('data', chunk => { buffer += chunk; for (let index; (index = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
    let reply; try { reply = JSON.parse(line) } catch { continue }
    if (reply.id === id) { clearTimeout(timer); socket.destroy(); resolve(reply); return }
  } })
})
try {
  await until('Host ready', async () => { try { return (await request('getSettings')).ok } catch { return false } })
  assert.equal((await request('updateSettings', { downloadDirectory: downloads, categorySubfolders: false })).ok, true)
  host.kill('SIGTERM'); await exited
  execFileSync('python3', ['-c', `
import sqlite3,sys,time
connection=sqlite3.connect(sys.argv[1])
rows=[('https://fixture.example.test/'+str(i), 'GET', '归档-'+str((i*7919)%10000).zfill(5)+'.txt', 'http', 1024, 'document', 'complete' if i%2==0 else 'paused', 4, time.time()-i, sys.argv[2]) for i in range(10000)]
connection.executemany('INSERT INTO downloads (url,method,filename,ltype,filesize,category,status,connections,firsttry,folderpath) VALUES (?,?,?,?,?,?,?,?,?,?)',rows)
connection.commit()
connection.close()
`, join(support, 'NeatDB.db'), downloads])
  host = spawn(binary, [], { env: { ...process.env, NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore' })
  exited = once(host, 'exit')
  await until('seeded host ready', async () => { try { return (await request('list')).tasks.length === 10000 } catch { return false } })
  if (process.argv.includes('--headless')) {
    const samples = []
    for (let index = 0; index < 3; index++) {
      const start = performance.now()
      assert.equal((await request('list')).tasks.length, 10000)
      samples.push(Math.round(performance.now() - start))
    }
    console.log(JSON.stringify({ hostLibraryRecords: 10000, listMilliseconds: samples, syntheticOnly: true }))
  } else {
    const appBinary = process.env.NDM_QA_APP_BINARY || 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    const appArguments = [...(process.env.NDM_QA_APP_BINARY ? [] : ['.']), `--user-data-dir=${join(root, 'electron')}`]
    ui = spawn(appBinary, appArguments, {
      env: { ...process.env, NDM_HOST_PORT: String(hostPort), NDM_BRIDGE_PORT: String(bridgePort), NDM_SUPPORT_DIR: support, NDM_DISABLE_LEGACY_BRIDGE: '1' }, stdio: 'ignore'
    })
    console.log(JSON.stringify({ fixtureReady: true, uiLaunched: true, root, hostPort, records: 10000, search: '09999', expectedMatches: 1 }))
    const { createInterface } = await import('node:readline')
    const lines = createInterface({ input: process.stdin })
    const timer = setTimeout(() => lines.close(), 10 * 60 * 1000)
    ui.once('exit', () => lines.close())
    try { for await (const line of lines) { if (line.trim() === 'done') break } }
    finally { clearTimeout(timer); lines.close() }
  }
  assert.equal((await request('list')).tasks.length, 10000)
  console.log(JSON.stringify({ fixtureUnchanged: true, tasks: 10000 }))

} finally {
  if (ui && ui.exitCode === null && ui.signalCode === null) { const done = once(ui, 'exit'); ui.kill('SIGTERM'); await done }
  host.kill('SIGTERM'); await exited
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(support)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  try { execFileSync('/usr/bin/defaults', ['delete', `ndm.support.${hash.toString(16)}`], { stdio: 'ignore' }) } catch { /* Owned fixture preferences only. */ }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ cleanup: true }))
}
