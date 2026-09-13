import assert from 'node:assert/strict'

// Synthetic task snapshots use the same production renderer and private engine
// as the motion suite. File actions end at instrumented Electron IPC handlers.
export async function runFileComponentCases({ app, win, capture, checks, startSampler, getTasks, setTasks, waitCount, waitPending, settle }) {
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1220, 780)
    globalThis.__ndmFileComponentReceipts = []
    for (const channel of ['system:open-path', 'system:quick-look', 'system:reveal-file']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, path) => {
        globalThis.__ndmFileComponentReceipts.push({ channel, path })
        return channel === 'system:open-path' ? '' : true
      })
    }
  })
  await win.emulateMedia({ reducedMotion: 'no-preference' })
  await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
  if (await win.getByRole('button', { name: '关闭任务详情', exact: true }).isVisible()) {
    await win.getByRole('button', { name: '关闭任务详情', exact: true }).click()
  }
  if (await win.getByRole('button', { name: '切换侧栏', exact: true }).getAttribute('aria-expanded') === 'false') {
    await win.getByRole('button', { name: '切换侧栏', exact: true }).click()
  }
  await win.getByRole('button', { name: '卡片视图', exact: true }).click()
  await win.locator('[data-task-gallery]').waitFor()
  const galleryScroll = win.locator('[data-task-gallery] .task-gallery-scroll')
  await galleryScroll.evaluate(node => { node.scrollTop = 0 })
  await win.locator('[data-gallery-card="100"]').waitFor()
  await win.waitForTimeout(250)
  const mounted = await win.locator('[data-gallery-card]').count()
  assert.ok(mounted > 0 && mounted < 100, '2000 tasks must keep fewer than 100 cards mounted')
  assert.equal(await win.getByRole('combobox', { name: '卡片页码', exact: true }).count(), 0, 'The gallery scrolls continuously without a page selector')
  assert.equal(await win.getByRole('button', { name: '下一页文件', exact: true }).count(), 0)
  assert.equal(await win.locator('.task-gallery-pagination').count(), 0)

  const defaultGeometry = await galleryScroll.evaluate(node => {
    const viewport = node.getBoundingClientRect()
    const clip = { top: Math.max(0, viewport.top), bottom: Math.min(innerHeight, viewport.bottom), left: Math.max(0, viewport.left), right: Math.min(innerWidth, viewport.right) }
    const cards = [...node.querySelectorAll('[data-gallery-card]')].map(card => {
      const box = card.getBoundingClientRect()
      const actions = card.querySelector('.gallery-card-actions')?.getBoundingClientRect()
      const primary = card.querySelector('[data-gallery-primary]')?.getBoundingClientRect()
      return { id: card.dataset.galleryCard, top: box.top, bottom: box.bottom, left: box.left, right: box.right,
        fullyVisible: box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1 && box.left >= clip.left - 1 && box.right <= clip.right + 1,
        actionsVisible: Boolean(actions && primary && actions.top >= clip.top - 1 && actions.bottom <= clip.bottom + 1 && primary.top >= box.top && primary.bottom <= Math.min(box.bottom, clip.bottom) + 1) }
    })
    const rows = [...new Set(cards.map(card => Math.round(card.top)))].sort((a, b) => a - b)
      .slice(0, 2).map(top => cards.filter(card => Math.abs(card.top - top) <= 1))
    const pseudoStacks = [...node.querySelectorAll('.gallery-file-paper')].flatMap(paper => ['::before', '::after'].map(pseudo => {
      const css = getComputedStyle(paper, pseudo)
      return { pseudo, content: css.content, display: css.display, opacity: css.opacity }
    })).filter(css => css.content !== 'none' && css.content !== 'normal' && css.display !== 'none' && Number(css.opacity) > 0)
    return { viewport: { width: innerWidth, height: innerHeight }, clip, rows, mounted: cards.length, pseudoStacks, overflow: node.scrollWidth - node.clientWidth }
  })
  await capture('20-gallery-default-two-rows')
  const geometryCheck = { name: 'Default gallery shows two complete action rows without stacked fallback sheets', passed: false, geometry: defaultGeometry }
  checks.push(geometryCheck)
  assert.equal(defaultGeometry.rows.length, 2, 'The default 1220×780 window shows two complete card rows')
  assert.ok(defaultGeometry.rows.reduce((count, row) => count + row.length, 0) >= 8, 'The first two complete rows expose at least eight cards')
  assert.ok(defaultGeometry.rows.flat().every(card => card.fullyVisible && card.actionsVisible), 'Every card and its entire action row fit in the first two visible rows')
  assert.equal(defaultGeometry.pseudoStacks.length, 0, 'Single-file fallback artwork must not render stacked pseudo-document sheets')
  assert.ok(defaultGeometry.overflow <= 1, 'Default gallery has no horizontal scroll')
  geometryCheck.passed = true

  const scrollEvidence = []
  for (const fraction of [.18, .5, .8, 1]) {
    const before = await win.locator('[data-gallery-card]').first().getAttribute('data-gallery-card')
    await galleryScroll.evaluate((node, fraction) => { node.scrollTop = (node.scrollHeight - node.clientHeight) * fraction }, fraction)
    await win.waitForFunction(before => document.querySelector('[data-gallery-card]')?.getAttribute('data-gallery-card') !== before, before)
    const sample = await galleryScroll.evaluate(node => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, viewportHeight: node.clientHeight,
      ids: [...node.querySelectorAll('[data-gallery-card]')].map(card => card.dataset.galleryCard) }))
    assert.ok(sample.ids.length > 0 && sample.ids.length < 100, 'Every continuous scroll position keeps a bounded number of cards mounted')
    scrollEvidence.push(sample)
  }
  await win.locator('[data-gallery-card="2099"]').waitFor()
  await capture('20-gallery-large-library')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 680))
  await win.waitForFunction(() => innerWidth === 740 && Number(document.querySelector('[data-gallery-columns]')?.getAttribute('data-gallery-columns')) === 3)
  await galleryScroll.evaluate(node => { node.scrollTop = node.scrollHeight })
  await win.locator('[data-gallery-card="2099"]').waitFor()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 780))
  await win.waitForFunction(() => {
    const last = document.querySelector('[data-gallery-card="2099"]')?.getBoundingClientRect()
    const scroll = document.querySelector('.task-gallery-scroll')?.getBoundingClientRect()
    return innerWidth === 1220 && Number(document.querySelector('[data-gallery-columns]')?.getAttribute('data-gallery-columns')) === 5
      && last && scroll && last.top >= scroll.top && last.bottom <= scroll.bottom + 1
  })
  checks.push({ name: 'Widening a deeply scrolled gallery retains the last files instead of jumping to the middle', passed: true })
  await win.locator('[data-gallery-card="2099"] [data-gallery-select]').focus()
  await win.keyboard.press('Home')
  await win.waitForFunction(() => document.activeElement?.getAttribute('data-gallery-select') === '100')
  await win.keyboard.press('End')
  await win.waitForFunction(() => document.activeElement?.getAttribute('data-gallery-select') === '2099')
  await win.keyboard.press('Home')
  await win.waitForFunction(() => document.activeElement?.getAttribute('data-gallery-select') === '100')
  assert.ok(await win.locator('[data-gallery-card]').count() < 100, 'Keyboard navigation does not mount the full library')
  checks.push({ name: '2000 cards scroll continuously to the last file and Home/End crosses the virtual range', passed: true, mounted, scrollEvidence })

  const synthetic = getTasks().slice(0, 8).map((task, index) => ({ ...task,
    status: index < 2 ? 'downloading' : index === 2 ? 'waiting' : 'complete',
    bytesPerSecond: index < 2 ? (index + 1) * 1024 ** 2 : 0,
    completedBytes: index > 2 ? task.fileSize : task.completedBytes,
    completedAt: index > 2 ? Date.now() - index * 1000 : undefined
  }))
  setTasks(synthetic)
  await waitCount(8)
  await win.locator('[data-gallery-card="100"]').waitFor()
  assert.equal(await win.locator('[data-completion-pocket], [data-pocket-paper]').count(), 0, 'Completed files appear once in the gallery without a duplicate pocket')
  assert.equal(await win.getByText('RECENT FILES', { exact: true }).count(), 0)
  const fallbackSheets = await win.locator('[data-task-gallery]').evaluate(node => [...node.querySelectorAll('[data-task-state="complete"] .gallery-file-figure, [data-task-state="complete"] .gallery-file-paper')]
    .flatMap(figure => ['::before', '::after'].map(pseudo => {
      const css = getComputedStyle(figure, pseudo)
      return { pseudo, content: css.content, display: css.display, opacity: css.opacity }
    })).filter(css => css.content !== 'none' && css.content !== 'normal' && css.display !== 'none' && Number(css.opacity) > 0))
  assert.equal(fallbackSheets.length, 0, 'A completed single-file fallback must not regain decorative stacked sheets')
  const active = win.locator('[data-gallery-card="100"]')
  assert.equal(await active.locator('[data-gallery-progress]').getAttribute('aria-valuenow'), '25')
  assert.match(await active.innerText(), /1(?:\.0+)?\s*MB\/s/, 'Active cards show the current transfer speed')
  const progressFrames = await startSampler('[data-gallery-card="100"] [data-gallery-progress] > span', 520)
  setTasks(getTasks().map(task => task.id === 100 ? { ...task, completedBytes: task.fileSize / 2, bytesPerSecond: 3 * 1024 ** 2 } : task))
  await win.waitForFunction(() => document.querySelector('[data-gallery-card="100"] [data-gallery-progress]')?.getAttribute('aria-valuenow') === '50')
  const progressTrace = await progressFrames.finish()
  const intermediateProgress = progressTrace.map(frame => /matrix\(([^,]+)/.exec(frame.transform)?.[1]).filter(Boolean).map(Number)
  assert.ok(intermediateProgress.some(value => value > .25 && value < .5), 'Confirmed progress updates pass through an actual intermediate fill frame')
  assert.match(await active.innerText(), /3(?:\.0+)?\s*MB\/s/)

  const waitingTask = getTasks().find(task => task.id === 102)
  const variant = win.locator('[data-gallery-card="102"]')
  setTasks(getTasks().map(task => task.id === 102 ? { ...task, status: 'downloading', fileSize: 0, completedBytes: 4 * 1024 ** 2, progressFraction: undefined, bytesPerSecond: 1024 ** 2 } : task))
  await win.waitForFunction(() => /4(?:\.0+)?\s*MB/.test(document.querySelector('[data-gallery-card="102"]')?.textContent ?? ''))
  assert.equal(await variant.locator('[role="progressbar"][aria-valuenow]').count(), 0, 'Unknown total must not announce false numeric progress')
  assert.doesNotMatch(await variant.innerText(), /\d\s*%/, 'Unknown total must not display a fabricated zero percent')
  setTasks(getTasks().map(task => task.id === 102 ? { ...task, fileSize: 80 * 1024 ** 2, completedBytes: 9 * 1024 ** 2, progressFraction: .25, isLiveRecording: true, phase: 'transferring' } : task))
  await variant.getByRole('button', { name: '停止并保存录制', exact: true }).waitFor()
  assert.equal(await variant.getByRole('button', { name: '停止并保存录制', exact: true }).isEnabled(), true)
  assert.match(await variant.innerText(), /已保存\s*9(?:\.0+)?\s*MB/)
  assert.doesNotMatch(await variant.innerText(), /\d\s*%/, 'Live recording shows saved bytes without a fictitious total')
  assert.equal(await variant.locator('[role="progressbar"][aria-valuenow]').count(), 0)
  setTasks(getTasks().map(task => task.id === 102 ? { ...task, phase: 'merging' } : task))
  await variant.getByRole('button', { name: '正在保存录制', exact: true }).waitFor()
  assert.equal(await variant.getByRole('button', { name: '正在保存录制', exact: true }).isDisabled(), true, 'Saving a live recording cannot be stopped a second time')
  setTasks(getTasks().map(task => task.id === 102 ? waitingTask : task))
  await win.waitForFunction(() => document.querySelector('[data-gallery-card="102"]')?.getAttribute('data-task-state') === 'waiting')
  checks.push({ name: 'Known progress animates from real snapshots; unknown totals, live bytes and merging keep honest states', passed: true, progressTrace })
  await capture('21-gallery-active-and-completed')
  await win.locator('[data-gallery-card="100"] [data-gallery-primary]').click()
  await waitPending()
  assert.equal(getTasks().find(task => task.id === 100).status, 'downloading', 'Click waits for the engine receipt')
  assert.equal(await active.locator('[data-gallery-primary]').getAttribute('aria-busy'), 'true')
  assert.equal(await active.locator('[data-gallery-primary]').isDisabled(), true)
  settle(true)
  await win.waitForFunction(() => {
    const card = document.querySelector('[data-gallery-card="100"]')
    const action = card?.querySelector('[data-gallery-primary]')
    return Boolean(action) && card.dataset.taskState === 'paused' && action.getAttribute('aria-busy') !== 'true'
  })
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
  checks.push({ name: 'Transfer island animates, opens temporary limits and returns focus in Electron', passed: true, islandFrames: frames })

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
  await win.evaluate(() => { document.documentElement.dataset.theme = 'walnut' })
  await win.getByRole('button', { name: '传输状态', exact: true }).click()
  const geometry = await win.locator('.transfer-control-popup').evaluate(node => {
    const box = node.getBoundingClientRect()
    return { x: box.x, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, horizontalOverflow: document.documentElement.scrollWidth - innerWidth }
  })
  assert.ok(geometry.x >= 0 && geometry.right <= geometry.viewportWidth + 1 && geometry.bottom <= geometry.viewportHeight + 1)
  assert.ok(geometry.horizontalOverflow <= 1)
  await capture('24-transfer-island-narrow-reduced')
  await win.keyboard.press('Escape')
  await win.locator('.transfer-control-popup').waitFor({ state: 'hidden' })
  // A modal temporarily aria-hides its siblings; the toolbar owns the actual
  // sidebar state. Read it after the popup exits before exercising the cards.
  if (await win.getByRole('button', { name: '切换侧栏', exact: true }).getAttribute('aria-expanded') === 'true') {
    await win.getByRole('button', { name: '收起侧栏', exact: true }).click()
  }
  await galleryScroll.evaluate(node => { node.scrollTop = 0 })
  await win.locator('[data-gallery-card="100"]').waitFor()
  const narrowCard = win.locator('[data-gallery-card="100"]')
  const beforeHover = await narrowCard.boundingBox()
  await narrowCard.hover()
  await win.waitForTimeout(180)
  const narrowGeometry = await galleryScroll.evaluate(node => {
    const viewport = node.getBoundingClientRect()
    const first = node.querySelector('[data-gallery-card="100"]')
    const box = first.getBoundingClientRect()
    const actions = first.querySelector('.gallery-card-actions').getBoundingClientRect()
    const css = getComputedStyle(first)
    const matrix = new DOMMatrixReadOnly(css.transform === 'none' ? undefined : css.transform)
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, actionsBottom: actions.bottom,
      clipBottom: Math.min(viewport.bottom, innerHeight), width: innerWidth, height: innerHeight,
      overflow: node.scrollWidth - node.clientWidth, documentOverflow: document.documentElement.scrollWidth - innerWidth,
      translate: css.translate, transform: css.transform,
      unscaled: matrix.is2D && Math.abs(matrix.a - 1) < .001 && Math.abs(matrix.b) < .001 && Math.abs(matrix.c) < .001 && Math.abs(matrix.d - 1) < .001 }
  })
  assert.ok(narrowGeometry.x >= 0 && narrowGeometry.right <= narrowGeometry.width + 1)
  assert.ok(narrowGeometry.actionsBottom <= narrowGeometry.clipBottom + 1, 'The first narrow card exposes its entire action row')
  assert.ok(narrowGeometry.overflow <= 1 && narrowGeometry.documentOverflow <= 1)
  assert.ok(Math.abs(narrowGeometry.y - beforeHover.y) <= .5, 'Reduced motion must not lift a hovered card')
  assert.ok(['none', '0px', '0px 0px'].includes(narrowGeometry.translate), 'Reduced motion clears card translation')
  assert.ok(narrowGeometry.unscaled, 'Reduced motion cannot scale or rotate card text; static virtual positioning is allowed')
  assert.equal(await win.locator('[data-completion-pocket]').count(), 0)
  await capture('25-gallery-narrow-reduced')
  checks.push({ name: 'Narrow reduced-motion gallery and transfer island fit without duplicated surfaces or hover travel', passed: true, geometry, narrowGeometry })

  setTasks(getTasks().map(task => task.id === 107 ? { ...task, filename: 'Synthetic installer.dmg', title: 'Synthetic installer.dmg', category: 'application' } : task))
  await app.evaluate(({ ipcMain }) => {
    globalThis.__ndmGalleryInstallCalls = 0
    ipcMain.removeHandler('system:install-disk-image')
    ipcMain.handle('system:install-disk-image', () => {
      globalThis.__ndmGalleryInstallCalls++
      return new Promise(resolve => { globalThis.__ndmGalleryInstallReply = resolve })
    })
  })
  await galleryScroll.evaluate(node => { node.scrollTop = node.scrollHeight })
  const installer = win.locator('[data-gallery-card="107"]')
  await installer.locator('[data-gallery-primary="install"]').waitFor()
  await installer.locator('[data-gallery-primary="install"]').evaluate(button => { button.click(); button.click() })
  assert.equal(await installer.locator('[data-gallery-primary]').getAttribute('aria-busy'), 'true')
  assert.equal(await installer.locator('[data-gallery-primary]').isDisabled(), true)
  assert.equal(await app.evaluate(() => globalThis.__ndmGalleryInstallCalls), 1, 'Repeated activation cannot dispatch a duplicate installer request')
  await app.evaluate(() => globalThis.__ndmGalleryInstallReply('合成测试：安装失败，请重试。'))
  await installer.locator('[data-gallery-install-error]').waitFor()
  await installer.getByRole('button', { name: '重试安装', exact: true }).click()
  await app.evaluate(() => globalThis.__ndmGalleryInstallReply(''))
  assert.equal(await app.evaluate(() => globalThis.__ndmGalleryInstallCalls), 2)
  checks.push({ name: 'DMG gallery actions use installation IPC, block duplicates, and expose retry after failure', passed: true })
}
