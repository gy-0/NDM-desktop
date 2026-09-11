// Real Swift-host history QA; all downloads and data live in this run's temp dir.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const disconnect = process.argv.includes('--disconnect')
const root = mkdtempSync(join(tmpdir(), 'ndm-history-native-'))
const payload = Buffer.from('NDM history QA: retain this downloaded file.\n')
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'content-length': payload.length })
  res.end(req.method === 'HEAD' ? undefined : payload)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const options = qaLaunchOptions(disconnect ? 'history-disconnect' : 'history-native')
let app
try {
  app = await electron.launch(options)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await win.waitForFunction(async () => await window.ndm.status() === 'live')
  const add = fields => win.evaluate(fields => window.ndm.request('add', fields), fields)
  const complete = await add({ url: `http://127.0.0.1:${server.address().port}/retained.txt`, filename: 'retained.txt', folderPath: root, autoStart: true })
  const paused = await add({ url: `http://127.0.0.1:${server.address().port}/paused.txt`, filename: 'paused.txt', folderPath: root, autoStart: false })
  const failed = await add({ url: 'http://127.0.0.1:9/failed.txt', filename: 'failed.txt', folderPath: root, autoStart: true })
  const ids = [complete, paused, failed].map(reply => reply.task.id)
  await win.waitForFunction(async ids => {
    const { tasks } = await window.ndm.request('list')
    return tasks.find(t => t.id === ids[0])?.status === 'complete' && tasks.find(t => t.id === ids[2])?.status === 'error'
  }, ids, { timeout: 30_000 })
  const pendingState = await win.evaluate(async id => (await window.ndm.request('list')).tasks.find(task => task.id === id).status, ids[1])
  assert.equal(readFileSync(join(root, 'retained.txt'), 'utf8'), payload.toString())

  await win.locator('#main-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await win.locator('.ndm-settings').getByRole('button', { name: '下载', exact: true }).click()
  await win.getByRole('button', { name: '清除下载记录…', exact: true }).click()
  const dialog = win.getByRole('alertdialog', { name: '清除下载记录', exact: true })
  await dialog.waitFor()
  assert.equal(await dialog.getByRole('checkbox').count(), 2)
  await dialog.getByRole('checkbox').nth(1).check()
  const clear = dialog.getByRole('button', { name: '清除 2 条记录', exact: true })
  if (disconnect) {
    // Only terminate this isolated Electron instance's direct Swift child.
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    const child = rows.split('\n').map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .find(row => row && Number(row[2]) === app.process().pid && row[3].includes('/NDMHost'))
    assert.ok(child && !child[3].includes('/Applications/NDM.app/'))
    const listener = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', child[1], `-iTCP:${options.env.NDM_HOST_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    assert.ok(listener.includes(`:${options.env.NDM_HOST_PORT} (LISTEN)`))
    process.kill(Number(child[1]), 'SIGTERM')
    await win.waitForFunction(async () => await window.ndm.status() !== 'live')
    await clear.click()
    await dialog.getByText('未能清除下载记录。请重试。', { exact: true }).waitFor()
    assert.equal(await dialog.getAttribute('aria-busy'), 'false')
    assert.equal(await clear.isEnabled(), true)
    assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isEnabled(), true)
    assert.equal(await clear.getAttribute('aria-describedby'), 'clear-history-status')
  } else {
    await clear.click()
    await dialog.getByText('已清除 2 条记录', { exact: true }).waitFor()
    const remaining = await win.evaluate(async () => (await window.ndm.request('list')).tasks)
    assert.deepEqual(remaining.map(task => task.id), [ids[1]])
    assert.equal(remaining[0].status, pendingState)
  }
  assert.equal(readFileSync(join(root, 'retained.txt'), 'utf8'), payload.toString())
  await win.screenshot({ path: join(root, disconnect ? 'disconnected.png' : 'cleared.png') })
  console.log(JSON.stringify({ passed: true, nativeHost: true, disconnected: disconnect, downloadedFilePreserved: true, unstartedTaskPreserved: disconnect ? null : true, root }))
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
