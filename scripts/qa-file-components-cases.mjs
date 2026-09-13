import assert from 'node:assert/strict'

// Synthetic task snapshots use the same production renderer and private engine
// as the motion suite. File actions end at instrumented Electron IPC handlers.
export async function runFileComponentCases({ app, win, capture, checks, startSampler, getTasks, setTasks, waitCount, waitPending, settle }) {
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1280, 820)
    globalThis.__ndmFileComponentReceipts = []
    for (const channel of ['system:open-path', 'system:quick-look', 'system:reveal-file']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, path) => {
        globalThis.__ndmFileComponentReceipts.push({ channel, path })
        return channel === 'system:open-path' ? '' : true
      })
    }
  })
  await win.getByRole('button', { name: '卡片视图', exact: true }).click()
  await win.locator('[data-task-gallery]').waitFor()
  const mounted = await win.locator('[data-gallery-card]').count()
  assert.ok(mounted > 0 && mounted <= 48, '2000 tasks must mount at most one page of cards')
  await win.getByRole('combobox', { name: '卡片页码', exact: true }).selectOption('41')
  await win.locator('[data-gallery-card="2099"]').waitFor()
  assert.equal(await win.locator('[data-gallery-card]').count(), 32, 'The final page exposes the last 32 tasks')
  await capture('20-gallery-large-library')
  checks.push({ name: 'Card overview bounds a 2000-task library to one page', passed: true, mounted })

  const synthetic = getTasks().slice(0, 8).map((task, index) => ({ ...task,
    status: index < 2 ? 'downloading' : index === 2 ? 'waiting' : 'complete',
    bytesPerSecond: index < 2 ? (index + 1) * 1024 ** 2 : 0,
    completedBytes: index > 2 ? task.fileSize : task.completedBytes,
    completedAt: index > 2 ? Date.now() - index * 1000 : undefined
  }))
  setTasks(synthetic)
  await waitCount(8)
  await win.locator('[data-gallery-card="100"]').waitFor()
  await capture('21-gallery-and-pocket')
  await win.locator('[data-gallery-card="100"] [data-gallery-primary]').click()
  await waitPending()
  assert.equal(getTasks().find(task => task.id === 100).status, 'downloading', 'Click waits for the engine receipt')
  settle(true)
  await win.waitForFunction(() => document.querySelector('[data-gallery-card="100"] [data-gallery-primary]')?.getAttribute('aria-busy') !== 'true')
  assert.equal(getTasks().find(task => task.id === 100).status, 'paused')
  checks.push({ name: 'Gallery actions reach the engine and wait for its receipt', passed: true })

  const completedCard = win.locator('[data-gallery-card="103"]')
  await completedCard.locator('[data-gallery-select]').focus()
  await completedCard.locator('[data-gallery-preview]').click()
  await completedCard.locator('[data-gallery-reveal]').click()
  await completedCard.locator('[data-gallery-primary]').click()
  const receipts = await app.evaluate(() => globalThis.__ndmFileComponentReceipts)
  assert.deepEqual(receipts.map(receipt => receipt.channel), ['system:quick-look', 'system:reveal-file', 'system:open-path'])
  assert.ok(receipts.every(receipt => receipt.path.endsWith('Motion QA 0003.zip')))
  checks.push({ name: 'Gallery preview, reveal and open send the correct file to Electron IPC', passed: true, receipts })

  const pocketFrames = await startSampler('[data-completion-pocket]', 520)
  await win.getByRole('button', { name: '展开文件', exact: true }).click()
  await win.getByRole('button', { name: '收起文件', exact: true }).waitFor()
  const pocketTrace = await pocketFrames.finish()
  assert.ok(new Set(pocketTrace.map(frame => Math.round(frame.height))).size > 2, 'File pocket expands through intermediate geometry')
  await win.locator('[data-completion-pocket]').getByRole('button', { name: '预览文件：Motion QA 0003.zip', exact: true }).click()
  assert.equal(await app.evaluate(() => globalThis.__ndmFileComponentReceipts.length), 4, 'Pocket actions reuse the real file command')
  await capture('22-pocket-expanded')
  await win.keyboard.press('Escape')
  await win.getByRole('button', { name: '展开文件', exact: true }).waitFor()

  const islandFrames = await startSampler('.transfer-control-popup', 480, { waitForChange: true })
  await win.getByRole('button', { name: '传输状态', exact: true }).click()
  await win.locator('.transfer-control-popup').waitFor()
  const frames = await islandFrames.finish()
  assert.ok(frames.some(frame => frame.opacity > 0 && frame.opacity < 1), 'Transfer island has a visible intermediate frame')
  assert.equal(await win.locator('[data-island-task]').count(), 2, 'Island shows the actual active and waiting tasks after pause')
  await capture('23-transfer-island')
  await win.getByRole('button', { name: '临时文件限速…', exact: true }).click()
  await win.getByRole('combobox', { name: '临时下载速度', exact: true }).waitFor()
  await win.getByRole('combobox', { name: '临时下载速度', exact: true }).selectOption(String(1048576))
  await win.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await win.getByRole('button', { name: '临时文件限速…', exact: true }).evaluate(node => node === document.activeElement), true)
  await win.keyboard.press('Escape')
  await win.locator('.transfer-control-popup').waitFor({ state: 'hidden' })
  checks.push({ name: 'File pocket expands, sends file commands, Escape returns, and transfer island animates in Electron', passed: true, pocketFrames: pocketTrace, islandFrames: frames })

  const search = win.getByRole('searchbox', { name: '搜索下载任务', exact: true })
  await search.fill('0003')
  await waitCount(1)
  await win.getByRole('button', { name: '传输状态', exact: true }).click()
  await win.locator('[data-island-task="101"]').click()
  await waitCount(8)
  assert.equal(await search.inputValue(), '')
  await win.locator('#task-inspector').waitFor()
  assert.ok((await win.locator('#task-inspector').innerText()).includes('Motion QA 0001.zip'))
  await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
  checks.push({ name: 'Transfer island reveals an inspected task outside the current search', passed: true })

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 680))
  await win.emulateMedia({ reducedMotion: 'reduce' })
  await win.getByRole('button', { name: '传输状态', exact: true }).click()
  const geometry = await win.locator('.transfer-control-popup').evaluate(node => {
    const box = node.getBoundingClientRect()
    return { x: box.x, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, horizontalOverflow: document.documentElement.scrollWidth - innerWidth }
  })
  assert.ok(geometry.x >= 0 && geometry.right <= geometry.viewportWidth + 1 && geometry.bottom <= geometry.viewportHeight + 1)
  assert.ok(geometry.horizontalOverflow <= 1)
  await capture('24-transfer-island-narrow-reduced')
  await win.keyboard.press('Escape')
  await win.getByRole('button', { name: '展开最近完成文件', exact: true }).click()
  const pocketGeometry = await win.locator('[data-completion-pocket]').evaluate(node => {
    const box = node.getBoundingClientRect()
    return { x: box.x, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight }
  })
  assert.ok(pocketGeometry.bottom <= pocketGeometry.height && pocketGeometry.x >= 0 && pocketGeometry.right <= pocketGeometry.width)
  const actionsFit = await win.locator('.completion-pocket-overview').evaluate(node => node.querySelector('.completion-pocket-card-actions button').getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom)
  assert.equal(actionsFit, true, 'The first file action must be fully visible without a vertical scroll')
  await capture('25-pocket-narrow-reduced')
  await win.keyboard.press('Escape')
  checks.push({ name: 'Narrow reduced-motion transfer island fits the viewport', passed: true, geometry })

  setTasks(getTasks().map(task => task.id === 107 ? { ...task, filename: 'Synthetic installer.dmg', title: 'Synthetic installer.dmg', category: 'application' } : task))
  await app.evaluate(({ ipcMain }) => {
    globalThis.__ndmGalleryInstallCalls = 0
    ipcMain.removeHandler('system:install-disk-image')
    ipcMain.handle('system:install-disk-image', () => {
      globalThis.__ndmGalleryInstallCalls++
      return new Promise(resolve => { globalThis.__ndmGalleryInstallReply = resolve })
    })
  })
  const installer = win.locator('[data-gallery-card="107"]')
  await installer.locator('[data-gallery-primary="install"]').click()
  assert.equal(await installer.locator('[data-gallery-primary]').getAttribute('aria-busy'), 'true')
  assert.equal(await installer.locator('[data-gallery-primary]').isDisabled(), true)
  await app.evaluate(() => globalThis.__ndmGalleryInstallReply('合成测试：安装失败，请重试。'))
  await installer.locator('[data-gallery-install-error]').waitFor()
  await installer.getByRole('button', { name: '重试安装', exact: true }).click()
  await app.evaluate(() => globalThis.__ndmGalleryInstallReply(''))
  assert.equal(await app.evaluate(() => globalThis.__ndmGalleryInstallCalls), 2)
  checks.push({ name: 'DMG gallery actions use installation IPC, block duplicates, and expose retry after failure', passed: true })
}
