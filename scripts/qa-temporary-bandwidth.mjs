import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTCPServer, createConnection } from 'node:net'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const options = qaLaunchOptions('temporary-bandwidth')
const MB = 1048576
const statePath = join(options.env.NDM_SUPPORT_DIR, 'temporary-bandwidth.json')
const results = { screenshots: [], errors: [], checks: [] }
let app, win
const payload = Buffer.alloc(64 * MB, 0x62)
const server = createServer((request, response) => {
  const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/)
  const start = range ? Number(range[1]) : 0
  const end = Math.min(range?.[2] ? Number(range[2]) : payload.length - 1, payload.length - 1)
  response.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
  })
  if (request.method === 'HEAD') { response.end(); return }
  let offset = start
  let timer
  response.on('close', () => clearTimeout(timer))
  const send = () => {
    if (response.destroyed) return
    const next = Math.min(offset + 256 * 1024, end + 1)
    const writable = response.write(payload.subarray(offset, next))
    offset = next
    if (offset > end) { response.end(); return }
    if (writable) timer = setTimeout(send, 5)
    else response.once('drain', () => { timer = setTimeout(send, 5) })
  }
  send()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
// Each attempt owns fresh free ports; PID-modulo slots can collide with a
// different long-lived QA run during a continuous audit.
async function freePort() {
  const listener = createTCPServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}
options.env.NDM_HOST_PORT = String(await freePort())
options.env.NDM_BRIDGE_PORT = String(await freePort())
async function waitForHostExit() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const listening = await new Promise(resolve => {
      const socket = createConnection({host:'127.0.0.1', port:Number(options.env.NDM_HOST_PORT)})
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (!listening) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The isolated host did not exit before relaunch')
}
async function launch() {
  app = await electron.launch(options)
  app.process().stderr?.on('data', chunk => { if (/NDMHost|Error|error/.test(String(chunk))) console.error(String(chunk)) })
  win = await app.firstWindow()
  win.on('pageerror', error => results.errors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await waitFor(async () => await win.evaluate(() => window.ndm.status()) === 'live' && (await rpc('getSettings')).ok === true)
}
async function rpc(op, extra = {}) { return win.evaluate(({op, extra}) => window.ndm.request(op, extra), {op, extra}) }
async function limit() { return (await rpc('getSettings')).settings.bandwidthLimitBytesPerSecond }
async function snapshot() { return rpc('temporaryBandwidthStatus') }
async function waitFor(predicate, timeout = 25_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await predicate()) return } catch { /* Startup/reconnect is not ready. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The isolated native condition did not settle')
}
async function waitForRestored(rate) {
  const deadline = Date.now() + 25_000
  const observations = []
  while (Date.now() < deadline) {
    try {
      const state = await snapshot(), actual = await limit()
      observations.push({status:state.status, limit:actual})
      if (state.status === 'inactive' && actual === rate) return
    } catch { /* The isolated host may still be reconnecting. */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Recovery did not settle: ${JSON.stringify(observations)}`)
}
async function shot(name) {
  await win.waitForTimeout(240)
  const path = join(options.env.NDM_SUPPORT_DIR, `${name}.png`)
  await win.screenshot({path}); results.screenshots.push(path)
}
try {
  await launch()
  const directory = join(options.env.NDM_SUPPORT_DIR, 'downloads')
  mkdirSync(directory, {recursive:true})
  await rpc('updateSettings', {bandwidthLimitBytesPerSecond: 7 * MB, downloadDirectory: directory, useCategoryFolders: false, maxConnections: 1, smartConnections: false})
  await win.getByRole('button', {name:'传输状态', exact:true}).click()
  await win.getByRole('button', {name:'临时文件限速…', exact:true}).click()
  await win.getByLabel('临时下载速度', {exact:true}).selectOption(String(MB))
  await win.getByLabel('临时限速时长', {exact:true}).selectOption('15')
  await shot('01-setup')
  const started = Date.now()
  await win.getByRole('button', {name:'应用限速', exact:true}).click()
  await win.getByText('临时文件限速 1 MB/s', {exact:true}).waitFor()
  assert.equal(await limit(), MB)
  const active = await snapshot()
  assert.equal(active.status, 'active')
  assert.equal(active.previousLimitBytesPerSecond, 7 * MB)
  assert.ok(active.expiresAt >= started + 15 * 60_000 && active.expiresAt <= Date.now() + 15 * 60_000)
  await shot('02-active')
  results.checks.push('UI applies an acknowledged 15-minute limit against the native engine')
  const transfer = await rpc('add', {url:`http://127.0.0.1:${server.address().port}/bandwidth.bin`, filename:'bandwidth.bin', autoStart:true})
  assert.ok(transfer.task?.id)
  const taskID = transfer.task.id
  const readTransfer = async () => (await rpc('list')).tasks.find(task => task.id === taskID)
  await waitFor(async () => (await readTransfer()).completedBytes > 0)
  async function measure() {
    const first = await readTransfer(), start = performance.now()
    const samples = []
    for (let index = 0; index < 12; index++) {
      await win.waitForTimeout(500)
      const sample = await readTransfer()
      samples.push({ms:Math.round(performance.now() - start), bytes:sample.completedBytes, speed:sample.bytesPerSecond, state:sample.status})
    }
    const last = await readTransfer()
    console.log('throughputSamples', JSON.stringify(samples))
    assert.ok(last.status === 'downloading' || last.status === 'complete')
    let lastChange = 0, previousBytes = first.completedBytes, maximumStall = 0
    for (const sample of samples) {
      maximumStall = Math.max(maximumStall, sample.ms - lastChange)
      if (sample.bytes !== previousBytes) { lastChange = sample.ms; previousBytes = sample.bytes }
    }
    if (!results.progressSamples) results.progressSamples = []
    results.progressSamples.push({samples, maximumStallMs:maximumStall})
    assert.ok(maximumStall < 1800, `Progress stalled for ${maximumStall} ms`)
    return (last.completedBytes - first.completedBytes) / ((performance.now() - start) / 1000) / MB
  }
  await win.waitForTimeout(1200)
  const limitedRate = await measure()
  assert.ok(limitedRate > 0.35 && limitedRate < 1.8, `Measured temporary limit: ${limitedRate} MB/s`)
  await win.getByRole('button', {name:'现在恢复', exact:true}).click()
  await win.getByRole('button', {name:'临时文件限速…', exact:true}).waitFor()
  assert.equal(await limit(), 7 * MB)
  assert.equal((await snapshot()).status, 'inactive')
  results.checks.push('Restore now returns to the actual previous limit')
  await win.waitForTimeout(1200)
  const restoredRate = await measure()
  assert.ok(restoredRate > limitedRate * 2, `Restoration must accelerate the transfer: ${limitedRate} -> ${restoredRate} MB/s`)
  results.measuredRatesMBps = {limited:limitedRate, restored:restoredRate}
  results.checks.push('Real native payload throughput respects the limit and accelerates after restoration')
  await waitFor(async () => (await readTransfer()).status === 'complete')
  assert.deepEqual(readFileSync(join(directory, 'bandwidth.bin')), payload)
  results.checks.push('The completed file exactly matches all 64 MB of source bytes')

  await rpc('startTemporaryBandwidth', {limitBytesPerSecond: MB, minutes: 15})
  await win.keyboard.press('Escape')
  await win.getByRole('button', {name:'设置', exact:true}).click()
  const settings = win.getByRole('dialog', {name:'设置', exact:true})
  await settings.getByRole('button', {name:'下载', exact:true}).click()
  assert.match(await settings.locator('[data-settings-bandwidth-hint]').innerText(), /手动修改将结束临时限速/)
  const custom = settings.getByRole('textbox', {name:'自定义下载速度，每秒 MB'})
  await custom.fill('3')
  await custom.press('Enter')
  await waitForRestored(3 * MB)
  assert.equal((await snapshot()).status, 'inactive')
  assert.equal(await limit(), 3 * MB)
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).lease, null)
  results.checks.push('Manual bandwidth changes cancel the earlier restore plan')
  await win.keyboard.press('Escape')

  await rpc('startTemporaryBandwidth', {limitBytesPerSecond: MB, minutes: 15})
  await app.close(); app = null
  await waitForHostExit()
  // Test a near-term deadline only in this isolated recovery record. Production
  // durations are unchanged; this verifies real wall-clock expiry after restart.
  const journal = JSON.parse(readFileSync(statePath, 'utf8'))
  journal.lease.expiresAt = Date.now() + 8000
  writeFileSync(statePath, JSON.stringify(journal))
  await launch()
  await win.getByRole('button', {name:'设置', exact:true}).click()
  const reopenedSettings = win.getByRole('dialog', {name:'设置', exact:true})
  await reopenedSettings.getByRole('button', {name:'下载', exact:true}).click()
  await waitForRestored(3 * MB)
  assert.equal((await snapshot()).status, 'inactive')
  await win.waitForFunction(() => document.querySelector('[data-settings-bandwidth-hint]')?.textContent === '普通文件按此限速；单项设置优先。')
  assert.equal(await reopenedSettings.getByRole('textbox', {name:'自定义下载速度，每秒 MB'}).inputValue(), '3')
  results.checks.push('Restart reads the journal and restores on a real shortened test deadline')
  results.checks.push('Settings shows the temporary scope and refreshes the restored custom speed while open')
  await win.keyboard.press('Escape')

  await rpc('startTemporaryBandwidth', {limitBytesPerSecond: MB, minutes: 15})
  await win.reload(); await win.waitForLoadState('domcontentloaded')
  await win.getByRole('button', {name:'传输状态', exact:true}).click()
  await win.getByText('临时文件限速 1 MB/s', {exact:true}).waitFor()
  results.checks.push('Renderer reload retains the main-process-owned temporary period')
  await rpc('restoreTemporaryBandwidth')
  assert.equal(await limit(), 3 * MB)
  assert.deepEqual(results.errors, [])
  writeFileSync(join(options.env.NDM_SUPPORT_DIR, 'result.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({root:options.env.NDM_SUPPORT_DIR,...results}))
} finally {
  await app?.close().catch(() => {})
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
