// Real Electron keyboard/focus QA with isolated fixture tasks and no external actions.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'

const root = mkdtempSync(join(tmpdir(), 'ndm-commands-'))
const tasks = [
  { id: 1, filename: '设计参考 A.txt', title: '设计参考 A.txt', status: 'complete', completedBytes: 1000 },
  { id: 2, filename: '素材 B.zip', title: '素材 B.zip', status: 'paused', completedBytes: 400 }
].map(task => ({ ...task, folderPath: root, url: `https://example.com/files/${task.id}`, pageURL: 'https://example.com/downloads', source: 'example.com', category: 'document', fileSize: 1000, bytesPerSecond: 0, connections: 4, segments: [], activityAt: Date.now() - task.id * 1000 }))
writeFileSync(join(root, tasks[0].filename), 'NDM command fixture\n')
const requests = []
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
      requests.push(request.op)
      const reply = { id: request.id, ok: true }
      if (request.op === 'list') reply.tasks = tasks
      if (request.op === 'getSettings') reply.settings = { downloadDirectory: root, maxConnections: 4, maxConcurrentDownloads: 4, smartConnectionsEnabled: false, bandwidthLimitBytesPerSecond: 0, bridgePort: 0 }
      if (request.op === 'getBridgeStatus') reply.bridge = { available: true, connectedClients: 0, expectedRelayVersion: '2.0.0', relayClients: [] }
      socket.write(JSON.stringify(reply) + '\n')
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const executablePath = process.env.NDM_QA_APP_PATH?.trim()
let app
try {
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [`--user-data-dir=${join(root, 'electron')}`] } : { args: ['.', `--user-data-dir=${join(root, 'electron')}`] }),
    env: { ...process.env, NDM_HOST_PORT: String(server.address().port), NDM_SUPPORT_DIR: join(root, 'engine'), NDM_BRIDGE_PORT: '0', NDM_DISABLE_LEGACY_BRIDGE: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await win.waitForFunction(async () => await window.ndm.status() === 'live')
  const errors = []
  win.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
  const palette = win.getByRole('dialog', { name: '快速操作', exact: true })
  const input = palette.getByRole('combobox', { name: '搜索操作' })
  const row = id => win.locator(`[data-task-select="${id}"]`)
  const activeId = () => input.getAttribute('aria-activedescendant')
  const open = async () => {
    await win.keyboard.press('Meta+k')
    await palette.waitFor()
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索操作')
  }
  const choose = async id => {
    await palette.locator(`[data-command-id="${id}"]`).click()
    await palette.waitFor({ state: 'hidden' })
  }
  const capture = async name => {
    await win.waitForTimeout(200)
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    writeFileSync(join(root, `${name}.png`), Buffer.from(png, 'base64'))
  }

  await open()
  assert.equal(await palette.locator('[data-command-context]').count(), 0)
  assert.equal(await palette.getByRole('group', { name: '当前所选' }).count(), 0)
  await input.fill('SETTINGS')
  assert.equal(await palette.getByRole('option').count(), 1)
  await input.press('Enter')
  await palette.waitFor({ state: 'hidden' })
  await win.locator('.ndm-settings').waitFor()
  await win.waitForFunction(() => Boolean(document.activeElement?.closest('.ndm-settings')), null, { timeout: 1500 })
  const settings = win.locator('.ndm-settings')
  await settings.evaluate(element => {
    const controls = Array.from(element.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'))
      .filter(control => control.getClientRects().length > 0)
    controls.at(-1).focus()
  })
  await win.keyboard.press('Tab')
  await win.waitForFunction(() => Boolean(document.activeElement?.closest('.ndm-settings')), null, { timeout: 1500 })
  await win.keyboard.press('Shift+Tab')
  await win.waitForFunction(() => Boolean(document.activeElement?.closest('.ndm-settings')), null, { timeout: 1500 }).catch(async error => {
    console.log('Settings reverse Tab focus:', await win.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.slice(0, 120), html: document.activeElement?.outerHTML?.slice(0, 500) })))
    throw error
  })
  await settings.getByRole('button', { name: '浏览器扩展', exact: true }).click()
  await settings.locator('[data-active-page="extensions"]').waitFor()
  assert.equal(await settings.evaluate(element => Boolean(element.closest('[inert]'))), false)
  await settings.getByRole('button', { name: '下载', exact: true }).click()
  await settings.getByRole('button', { name: '清除下载记录…', exact: true }).click()
  const cleanup = win.getByRole('alertdialog', { name: '清除下载记录', exact: true })
  await cleanup.waitFor()
  await win.waitForFunction(() => document.activeElement?.closest('[role="alertdialog"]') !== null)
  assert.equal(await cleanup.evaluate(element => Boolean(element.closest('[inert]'))), false)
  await win.keyboard.press('Escape')
  await cleanup.waitFor({ state: 'hidden' })
  await settings.waitFor()
  await win.waitForFunction(() => Boolean(document.activeElement?.closest('.ndm-settings')))
  await settings.getByRole('button', { name: '通用', exact: true }).click()
  await settings.getByRole('button', { name: '重新引导', exact: true }).click()
  const onboarding = win.getByRole('dialog', { name: '欢迎使用 NDM', exact: true })
  await onboarding.waitFor()
  await win.waitForFunction(() => Boolean(document.activeElement?.closest('.onboarding-dialog')))
  assert.equal(await onboarding.evaluate(element => Boolean(element.closest('[inert]'))), false)
  await win.keyboard.press('Escape')
  await onboarding.waitFor({ state: 'hidden' })
  await win.locator('[data-settings-trigger]').click()
  await settings.waitFor()
  await win.waitForFunction(() => Boolean(document.activeElement?.closest('.ndm-settings')))
  await win.keyboard.press('Meta+,')
  await settings.waitFor({ state: 'hidden' })
  await win.waitForFunction(() => document.activeElement?.hasAttribute('data-settings-trigger'))

  await open()
  await choose('new-download')
  await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '下载链接')
  await win.keyboard.press('Escape')
  await win.locator('.ndm-composer').waitFor({ state: 'hidden' })

  await row(1).click()
  await open()
  assert.match(await palette.locator('[data-command-context]').innerText(), /设计参考 A\.txt/)
  const initial = await activeId()
  await input.press('ArrowDown')
  assert.notEqual(await activeId(), initial)
  await input.press('ArrowUp')
  assert.equal(await activeId(), initial)
  await input.press('ArrowUp')
  assert.match(await activeId(), /welcome$/)
  assert.equal(await palette.locator('[data-command-id="welcome"]').evaluate(element => {
    const item = element.getBoundingClientRect()
    const list = element.closest('[role="listbox"]').getBoundingClientRect()
    return item.top >= list.top && item.bottom <= list.bottom
  }), true, 'keyboard movement must reveal the selected action in the results viewport')
  await input.fill('复制链接')
  assert.equal(await palette.getByRole('option').count(), 1)
  assert.equal(await palette.locator('[data-command-id="task-copy"]').isVisible(), true)
  await input.fill('预览')
  assert.equal(await palette.getByRole('option').count(), 1)
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  assert.equal(await palette.isVisible(), true, 'IME confirmation must not execute an action')
  await input.fill('this-operation-does-not-exist')
  await palette.getByText('没有找到这个操作', { exact: true }).waitFor()
  assert.equal(await activeId(), null)
  await input.press('Enter')
  assert.equal(await palette.isVisible(), true)
  await input.fill('')
  const listBounds = await palette.getByRole('listbox').boundingBox()
  const scrollBeforeHover = await palette.getByRole('listbox').evaluate(element => element.scrollTop)
  await win.mouse.move(listBounds.x + 35, listBounds.y + listBounds.height - 6)
  await win.waitForTimeout(120)
  assert.equal(await palette.getByRole('listbox').evaluate(element => element.scrollTop), scrollBeforeHover, 'hovering a clipped result must not shift the results list')
  await win.mouse.move(40, 40)
  await input.fill('预览')
  await input.fill('')
  await capture('01-dark-selected')
  assert.equal(await palette.locator('[data-command-id="task-preview"] span.block').first().evaluate(element => getComputedStyle(element).fontSize), '16px')
  await input.press('Escape')
  await palette.waitFor({ state: 'hidden' })
  assert.equal(await row(1).getAttribute('aria-pressed'), 'true', 'Escape closes only the palette')
  await win.waitForFunction(() => document.activeElement?.getAttribute('data-task-select') === '1')

  await win.getByRole('button', { name: '快速操作', exact: true }).click()
  await palette.waitFor()
  await choose('search')
  await win.waitForFunction(() => document.activeElement?.id === 'ndm-search')

  await open()
  const removalsBefore = requests.filter(op => /delete|remove/i.test(op)).length
  await choose('task-delete')
  const deletion = win.getByRole('alertdialog')
  await deletion.waitFor()
  assert.equal(requests.filter(op => /delete|remove/i.test(op)).length, removalsBefore, 'Delete must open confirmation before modifying tasks')
  await win.keyboard.press('Escape')
  await deletion.waitFor({ state: 'hidden' })

  await row(2).click({ modifiers: ['Meta'] })
  await open()
  assert.match(await palette.locator('[data-command-context]').innerText(), /2/)
  const selectionActions = await palette.getByRole('group', { name: '当前所选' }).getByRole('option').evaluateAll(elements => elements.map(element => element.getAttribute('data-command-id')))
  assert.deepEqual(selectionActions, ['selection-copy', 'selection-delete'])
  await input.press('Escape')
  await palette.waitFor({ state: 'hidden' })
  await row(2).click()
  await open()
  await input.press('ArrowDown')
  assert.match(await activeId(), /task-copy$/)
  await input.fill('preview')
  assert.equal(await palette.locator('[data-command-id="task-preview"]').isDisabled(), true)
  await input.press('Enter')
  assert.equal(await palette.isVisible(), true, 'unavailable-only results cannot execute')
  await input.fill('')
  await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
  await capture('02-dawn-paused')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 700))
  await capture('03-dawn-narrow')
  assert.equal(await palette.evaluate(element => element.scrollWidth <= element.clientWidth), true)
  await input.press('Escape')
  await palette.waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  writeFileSync('/tmp/ndm-command-palette-qa-latest.json', JSON.stringify({ root }))
  console.log(JSON.stringify({ passed: true, root, searchAndKeyboard: true, IME: true, noUnderlyingActions: true, focusHandoff: true, scopedCommands: true, deletionConfirmation: true }))
} finally {
  await app?.close()
  sockets.forEach(socket => socket.destroy())
  await new Promise(resolve => server.close(resolve))
}
