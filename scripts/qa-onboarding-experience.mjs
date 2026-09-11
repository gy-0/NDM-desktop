// Real Electron first-run flow with an isolated empty engine and controlled
// bridge responses. No live clipboard, browser, Finder or downloads are used.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const root = mkdtempSync(join(tmpdir(), 'ndm-onboarding-'))
const operations = []
let bridge = { available: true, connectedClients: 0, expectedRelayVersion: '2.0.0', relayClients: [] }
let bridgeFails = false
const sockets = new Set()
const server = createServer(socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n')
      const request = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      operations.push(request.op)
      const reply = { id: request.id, ok: true }
      if (request.op === 'list') reply.tasks = []
      if (request.op === 'getSettings') reply.settings = { downloadDirectory: root, maxConnections: 4, maxConcurrentDownloads: 4, bandwidthLimitBytesPerSecond: 0, bridgePort: 0 }
      if (request.op === 'getBridgeStatus') {
        if (bridgeFails) { reply.ok = false; reply.error = 'Controlled bridge failure' }
        else reply.bridge = bridge
      }
      socket.write(JSON.stringify(reply) + '\n')
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const executablePath = process.env.NDM_QA_APP_PATH?.trim()
let app
const failures = []
const outcomes = []
try {
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [`--user-data-dir=${join(root, 'electron')}`] } : { args: ['.', `--user-data-dir=${join(root, 'electron')}`] }),
    env: { ...process.env, NDM_HOST_PORT: String(server.address().port), NDM_SUPPORT_DIR: join(root, 'engine'), NDM_BRIDGE_PORT: '0', NDM_DISABLE_LEGACY_BRIDGE: '1' }
  })
  const win = await app.firstWindow()
  win.on('pageerror', error => failures.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(async () => await window.ndm.status() === 'live')
  await app.evaluate(({ ipcMain }) => {
    globalThis.onboardingQA = { openFailure: '', opens: 0, clipboardReads: 0 }
    ipcMain.removeHandler('system:open-path')
    ipcMain.handle('system:open-path', () => { globalThis.onboardingQA.opens++; return globalThis.onboardingQA.openFailure })
    ipcMain.removeHandler('system:read-clipboard')
    ipcMain.handle('system:read-clipboard', () => { globalThis.onboardingQA.clipboardReads++; return '' })
    ipcMain.removeHandler('system:clipboard-snapshot')
    ipcMain.handle('system:clipboard-snapshot', () => { globalThis.onboardingQA.clipboardReads++; return { text: '', changeCount: 0, selfWritten: false } })
  })
  // Reload with IPC instrumentation installed, keeping this first-run profile.
  await win.reload()
  const dialog = win.getByRole('dialog', { name: '欢迎使用 NDM' })
  const step = name => dialog.locator(`[data-onboarding-step="${name}"]`)
  const button = name => dialog.getByRole('button', { name, exact: true })
  const demo = dialog.locator('[data-onboarding-demo]')
  const relay = dialog.locator('[data-onboarding-relay-status]')
  const capture = async name => {
    await win.waitForTimeout(220)
    const encoded = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    writeFileSync(join(root, `${name}.png`), Buffer.from(encoded, 'base64'))
  }
  const resize = async (width, height, zoom = 1) => {
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.webContents.setZoomFactor(size.zoom)
      window.setMinimumSize(400, 400)
      window.setSize(size.width, size.height)
    }, { width, height, zoom })
    await win.waitForTimeout(220)
  }
  const check = async (name, run) => {
    try { await run(); outcomes.push({ name, passed: true }) }
    catch (error) { outcomes.push({ name, passed: false, error: error.message }); await capture(`failure-${outcomes.length}`); throw error }
  }
  const assertNoTasks = () => assert.deepEqual(operations.filter(op => !['list', 'getSettings', 'getBridgeStatus'].includes(op)), [], 'onboarding must not ask the engine to create, probe, or change tasks')
  const reopen = async () => {
    await win.locator('[data-settings-trigger]').click()
    await win.locator('.ndm-settings').getByRole('button', { name: '重新引导', exact: true }).click()
    await step('welcome').waitFor()
    await win.waitForTimeout(220)
  }
  await dialog.waitFor()
  await resize(1220, 780)

  await check('first run is quiet; focus stays in the dialog', async () => {
    assert.equal(await demo.getAttribute('data-demo-phase'), 'ready')
    assert.equal(await dialog.getByText('交互演示', { exact: true }).isVisible(), true)
    assert.equal(await dialog.getByText('演示不会下载文件', { exact: true }).isVisible(), true)
    for (const key of ['Tab', 'Shift+Tab', ...Array(14).fill('Tab'), ...Array(14).fill('Shift+Tab')]) {
      await win.keyboard.press(key)
      await win.waitForTimeout(35)
      const focus = await win.evaluate(() => ({ inside: Boolean(document.activeElement?.closest('[role="dialog"]')), element: document.activeElement?.outerHTML.slice(0, 500) }))
      assert.equal(focus.inside, true, `focus escaped after ${key}: ${focus.element}`)
    }
    await step('welcome').getByRole('heading').focus()
    await win.keyboard.press('Enter')
    assert.equal(await step('welcome').isVisible(), true, 'Enter on the heading must not advance')
    assert.equal(await demo.getAttribute('data-demo-phase'), 'ready')
    assert.equal(await app.evaluate(() => globalThis.onboardingQA.clipboardReads), 0)
    assertNoTasks()
  })

  await check('theme controls respond to their own Enter key and persist', async () => {
    for (const [name, id] of [['雾昼', 'dawn'], ['白昼', 'noon'], ['墨夜', 'walnut']]) {
      await button(`使用${name}`).focus()
      await win.keyboard.press('Enter')
      assert.equal(await win.evaluate(() => document.documentElement.dataset.theme), id)
      assert.equal(await button(`使用${name}`).getAttribute('aria-pressed'), 'true')
      assert.equal(await step('welcome').isVisible(), true)
      await capture(`welcome-${id}`)
    }
    await button('使用雾昼').click()
  })

  await check('demonstration pauses, resumes, completes and replays without a task', async () => {
    await button('开始演示').focus()
    await win.keyboard.press('Space')
    await win.waitForFunction(() => document.querySelector('[data-onboarding-demo]')?.dataset.demoPhase === 'running')
    await win.waitForTimeout(560)
    await button('暂停演示').click()
    const pausedProgress = await demo.getByRole('progressbar').getAttribute('aria-valuenow')
    await win.waitForTimeout(440)
    assert.equal(await demo.getByRole('progressbar').getAttribute('aria-valuenow'), pausedProgress)
    await button('继续演示').focus()
    await win.keyboard.press('Enter')
    await button('重新演示').waitFor({ timeout: 14_000 })
    assert.equal(await demo.getByRole('progressbar').getAttribute('aria-valuenow'), '100')
    await capture('demo-complete')
    await button('重新演示').click()
    await button('暂停演示').click()
    assert.ok(Number(await demo.getByRole('progressbar').getAttribute('aria-valuenow')) < 40)
    assert.equal(await step('welcome').isVisible(), true)
    assertNoTasks()
  })

  await check('browser connection requires a real, current Relay heartbeat', async () => {
    const before = await dialog.boundingBox()
    await button('连接浏览器').click()
    await step('browser').waitFor()
    await relay.getByText('等待浏览器连接', { exact: true }).waitFor()
    const after = await dialog.boundingBox()
    assert.ok(Math.abs(before.height - after.height) < 2, 'page change must keep dialog height stable')
    await button('打开扩展目录').click()
    await dialog.getByText(/已在访达中打开/).waitFor()
    assert.equal(await relay.getAttribute('data-verified'), 'false', 'opening Finder is not a connected browser')
    await app.evaluate(() => { globalThis.onboardingQA.openFailure = 'Test permission error' })
    await button('打开扩展目录').click()
    await dialog.getByText(/未能打开扩展目录/).waitFor()
    assert.equal(await relay.getAttribute('data-verified'), 'false')
    bridge = { ...bridge, connectedClients: 1, relayClients: [{ version: '1.0.0', protocol: 1, role: 'worker' }] }
    await relay.getByText('扩展需要更新', { exact: true }).waitFor({ timeout: 5000 })
    assert.equal(await relay.getAttribute('data-verified'), 'false')
    bridge = { ...bridge, relayClients: [{ version: '2.0.0', protocol: 1, role: 'worker' }] }
    await relay.locator('[role="status"]').getByText('准备好接收下载了', { exact: true }).waitFor({ timeout: 5000 })
    assert.equal(await relay.getAttribute('data-verified'), 'true')
    assert.equal(await dialog.getByText(/未能打开扩展目录/).count(), 0, 'connected state clears obsolete setup errors')
    assert.equal(await button('打开扩展目录').count(), 0, 'completed setup no longer asks to install the extension')
    await capture('browser-connected')
    bridgeFails = true
    await relay.getByText('状态暂不可用', { exact: true }).waitFor({ timeout: 5000 })
    assert.equal(await relay.getAttribute('data-verified'), 'false', 'a failed refresh must not leave a green status')
    assert.equal(await dialog.getByText(/未能打开扩展目录/).count(), 0, 'obsolete setup errors must not return after a later disconnect')
    bridgeFails = false
    bridge = { ...bridge, connectedClients: 0, relayClients: [] }
    await relay.getByText('等待浏览器连接', { exact: true }).waitFor({ timeout: 5000 })
    await button('返回').click()
    await step('welcome').waitFor()
    assert.equal(await button('使用雾昼').getAttribute('aria-pressed'), 'true')
    assertNoTasks()
  })

  await check('narrow and zoomed windows keep every control reachable', async () => {
    for (const size of [[900, 700, 1], [740, 600, 1], [900, 700, 1.25], [900, 700, 1.5]]) {
      await resize(...size)
      for (const page of ['welcome', 'browser']) {
        if (page === 'browser') { await button('连接浏览器').click(); await step('browser').waitFor(); await win.waitForTimeout(220) }
        const geometry = await dialog.evaluate(element => {
          const box = element.getBoundingClientRect()
          const content = element.querySelector('.onboarding-page').getBoundingClientRect()
          const footer = element.querySelector('.onboarding-footer').getBoundingClientRect()
          return { horizontalOverflow: element.scrollWidth - element.clientWidth, top: box.top, bottom: box.bottom, height: innerHeight, contentBottom: content.bottom, footerTop: footer.top }
        })
        assert.ok(geometry.horizontalOverflow <= 1, `${size}: ${page} has horizontal overflow`)
        assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height + 1, `${size}: dialog exceeds the viewport`)
        assert.ok(geometry.footerTop >= geometry.contentBottom - 1, `${size}: ${page} footer overlaps page content by ${Math.round(geometry.contentBottom - geometry.footerTop)}px`)
        await button('开始使用').scrollIntoViewIfNeeded()
        const footer = await button('开始使用').boundingBox()
        assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= geometry.height + 1, `${size}: final action cannot be reached`)
        await capture(`${page}-${size.join('x')}`)
        if (page === 'browser') { await button('返回').click(); await step('welcome').waitFor(); await win.waitForTimeout(220) }
      }
    }
    await resize(1220, 780)
  })

  await check('reduced motion remains interactive without the liquid shader', async () => {
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await button('连接浏览器').click()
    await step('browser').waitFor()
    await button('返回').click()
    await step('welcome').waitFor()
    await button('开始演示').click()
    await win.waitForTimeout(400)
    assert.equal(await demo.locator('canvas').count(), 0)
    assert.ok(Number(await demo.getByRole('progressbar').getAttribute('aria-valuenow')) > 24)
    await button('暂停演示').click()
    await win.emulateMedia({ reducedMotion: 'no-preference' })
  })

  await check('start, reopen, Escape and skip all finish without adding tasks', async () => {
    assert.equal(await app.evaluate(() => globalThis.onboardingQA.clipboardReads), 0, 'the complete onboarding flow must not read clipboard contents')
    await button('开始使用').click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await win.evaluate(() => localStorage.getItem('ndm.onboarded')), '1')
    assert.equal(await win.evaluate(() => localStorage.getItem('ndm-theme')), 'dawn')
    assert.equal(await win.locator('[data-task-select]').count(), 0)
    await reopen()
    await win.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await reopen()
    await button('跳过').click()
    await dialog.waitFor({ state: 'hidden' })
    assertNoTasks()
  })

  await check('add your own download opens the composer without submitting', async () => {
    await reopen()
    await button('添加自己的下载').click()
    await dialog.waitFor({ state: 'hidden' })
    const composer = win.getByRole('dialog', { name: '添加下载', exact: true })
    await composer.waitFor()
    assert.equal(await composer.getByRole('textbox', { name: '下载链接' }).inputValue(), '')
    assertNoTasks()
    await composer.getByRole('button', { name: '取消', exact: true }).click()
  })
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ passed: true, root, outcomes, operations: [...new Set(operations)], pageErrors: failures }))
} catch (error) {
  console.error(JSON.stringify({ passed: false, root, outcomes, pageErrors: failures }))
  throw error
} finally {
  await app?.close()
  sockets.forEach(socket => socket.destroy())
  await new Promise(resolve => server.close(resolve))
}
