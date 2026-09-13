import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createPortReservation } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const primaryBinary = '/opt/homebrew/bin/aria2c', auxiliaryBinary = join(process.cwd(), 'native/Vendor/Tools/aria2-next')
test('real standard aria2 HTTP and pinned auxiliary SFTP share one total before admission and bound simultaneous payload throughput', {
  skip: process.env.NDM_RUN_AUXILIARY_REAL !== '1' || process.platform !== 'darwin' || !existsSync(primaryBinary) || !existsSync(auxiliaryBinary) || !process.env.NDM_SFTP_FIXTURE_PYTHON, timeout: 45000
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-windows-budget-real-'))
  const fixture = spawn(process.env.NDM_SFTP_FIXTURE_PYTHON, ['scripts/qa-sftp-fixture.py', '--bytes', '8388608', '--delay', '0'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const fixtureExit = once(fixture, 'exit')
  let metadata
  t.after(async () => { fixture.kill('SIGTERM'); await fixtureExit; if (metadata) await rm(metadata.root, { recursive: true, force: true }) })
  const metadataPath = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('SFTP fixture timeout')), 10000)
    fixture.once('error', reject)
    fixture.stdout.on('data', chunk => { text += String(chunk); if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0]).metadataPath) } catch { reject(new Error('Invalid metadata')) } } })
  })
  metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  const payload = Buffer.alloc(8 * 1024 * 1024)
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1
    res.writeHead(range ? 206 : 200, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${payload.length}` } : {}) })
    if (req.method === 'HEAD') res.end(); else res.end(payload.subarray(start, end + 1))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const reservation = createPortReservation()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const engine = new WindowsDownloadEngine({ stateDirectory: join(root, 'state'), defaultDownloadDirectory: join(root, 'downloads'), aria2Path: primaryBinary,
    ytDlpPath: '', ffmpegPath: '', rpcPort: port, auxiliaryPath: auxiliaryBinary, auxiliaryManifestPath: join(process.cwd(), 'native/Vendor/Tools/aria2-next-manifest.json'), auxiliaryLoopbackOnly: true, auxiliaryPeerDiscovery: false }, { onEvent() {}, onStatus() {} })
  t.after(async () => {
    const child = engine.child
    await engine.stop()
    const deadline = Date.now() + 6000
    while (child && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await wait(50)
    assert.ok(!child || child.exitCode !== null || child.signalCode !== null, 'Primary child must stop')
    assert.equal(engine.auxiliaryDaemon.peekRPC(), null)
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true })
  })
  await engine.start(); assert.equal(engine.primaryReady, true)
  let totalLimit = 512 * 1024
  await engine.request('updateSettings', { bandwidthLimitBytesPerSecond: totalLimit })
  const url = `http://127.0.0.1:${server.address().port}`
  const primary = await engine.request('add', { url: `${url}/primary.bin`, autoStart: true })
  assert.equal(Number((await engine.rpc.call('getGlobalOption'))['max-overall-download-limit']), totalLimit)
  const added = await engine.request('auxiliaryCreate', { creationKey: randomUUID(), source: { kind: 'sftp', url: metadata.url, hostKeySHA256: metadata.hostKeySHA256 }, credentials: { username: metadata.username, password: metadata.password }, autoStart: false })
  assert.equal(added.task.auxiliary.phase, 'paused')
  const rpc = engine.auxiliaryDaemon.peekRPC(), original = rpc.call.bind(rpc)
  let checkedAdmissions = 0
  rpc.call = async (method, params) => {
    if (method === 'aria2.unpause') {
      const primaryCap = Number((await engine.rpc.call('getGlobalOption'))['max-overall-download-limit'])
      const auxiliaryCap = Number((await original('aria2.getGlobalOption'))['max-overall-download-limit'])
      assert.ok(primaryCap > 0 && auxiliaryCap > 0 && primaryCap + auxiliaryCap <= totalLimit, 'Both actual caps must fit before auxiliary unpause')
      checkedAdmissions++
    }
    return original(method, params)
  }
  await engine.request('resume', { taskID: added.taskID })
  assert.equal(checkedAdmissions, 1)
  const gid = JSON.parse(await readFile(join(root, 'state', 'auxiliary-tasks', String(added.taskID), '1', 'transfer.json'), 'utf8')).gid
  const primaryGID = engine.tasks.find(task => task.id === primary.task.id).gid
  const progress = async () => {
    const states = await Promise.all([engine.rpc.call('tellStatus', [primaryGID]), original('aria2.tellStatus', [gid])])
    return states.map(status => Number(status.completedLength))
  }
  await wait(3000)
  const begin = await progress(), started = Date.now()
  await wait(6000)
  const end = await progress(), seconds = (Date.now() - started) / 1000
  assert.ok(end[0] > begin[0] && end[1] > begin[1], JSON.stringify({ message: 'Both real protocols must transfer payload simultaneously', begin, end, auxiliary: await original('aria2.tellStatus', [gid]), primary: await engine.rpc.call('tellStatus', [primaryGID]) }))
  const bytes = end[0] - begin[0] + end[1] - begin[1]
  assert.ok(bytes <= totalLimit * seconds * 1.35 + 256 * 1024, `Combined payload ${bytes} exceeds bounded window ${seconds}s at ${totalLimit}B/s`)
  totalLimit = 256 * 1024
  await engine.request('updateSettings', { bandwidthLimitBytesPerSecond: totalLimit })
  assert.equal(Number((await engine.rpc.call('getGlobalOption'))['max-overall-download-limit']), totalLimit / 2)
  assert.equal(Number((await original('aria2.getGlobalOption'))['max-overall-download-limit']), totalLimit / 2)
  await engine.request('pause', { taskID: primary.task.id })
  const deadline = Date.now() + 4000
  while (Number((await original('aria2.getGlobalOption'))['max-overall-download-limit']) !== totalLimit && Date.now() < deadline) await wait(100)
  assert.equal(Number((await original('aria2.getGlobalOption'))['max-overall-download-limit']), totalLimit)
  t.diagnostic(JSON.stringify({ standardHTTPAndPinnedSFTP: true, checkedAdmissions, primaryBytes: end[0] - begin[0], auxiliaryBytes: end[1] - begin[1], seconds, totalLimitBeforeChange: 512 * 1024 }))
})
