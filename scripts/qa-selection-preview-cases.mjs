import assert from 'node:assert/strict'

// These cases run inside the existing private Electron/TCP fixture. The drawer
// only inspects selected tasks; the one pause receipt below exercises its busy UI.
export async function runSelectionPreviewCases({ app, win, capture, checks, startSampler, getTasks, setTasks, getRequests, waitCount, waitPending, settle }) {
  const savedTasks = structuredClone(getTasks())
  const windowSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  const savedUI = await win.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    scrollTop: document.querySelector('.task-table section')?.scrollTop ?? 0,
    sidebar: document.querySelector('button[aria-label="切换侧栏"]')?.getAttribute('aria-expanded')
  }))
  const trigger = win.locator('[data-selection-preview-trigger]')
  const popup = win.locator('[data-selection-preview-popup]')
  const list = win.locator('[data-selection-preview-list]')
  const rows = win.locator('[data-selection-preview-item]')
  const toolbar = win.getByRole('toolbar', { name: '批量任务操作', exact: true })
  const mutations = () => getRequests().filter(request => ['pause', 'resume', 'add', 'addMedia', 'remove', 'removeMany', 'restart', 'renew'].includes(request.op))
  const setWindow = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), [width, height])
    await win.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, [width, height], { timeout: 4000 })
  }
  const closeInspector = async () => {
    const close = win.getByRole('button', { name: '关闭任务详情', exact: true })
    if (await close.isVisible()) await close.click()
  }
  const clearSelection = async () => {
    if (await popup.isVisible()) { await win.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden', timeout: 4000 }) }
    const clear = toolbar.getByRole('button', { name: '取消选择', exact: true })
    if (await clear.isVisible()) { await clear.click(); await toolbar.waitFor({ state: 'hidden', timeout: 4000 }) }
  }
  const closeDrawer = async () => {
    await win.keyboard.press('Escape')
    await popup.waitFor({ state: 'hidden', timeout: 4000 })
    await win.waitForFunction(() => document.activeElement?.matches('[data-selection-preview-trigger]'), null, { timeout: 4000 })
  }
  const exactSelectedRows = async expected => {
    const ids = await rows.evaluateAll(nodes => nodes.map(node => Number(node.dataset.selectionPreviewItem)))
    assert.deepEqual(ids.sort((a, b) => a - b), [...expected].sort((a, b) => a - b), 'The drawer must show exactly the selected task IDs')
    return ids
  }
  let pausePending = false

  try {
    await win.emulateMedia({ reducedMotion: 'no-preference' })
    await win.evaluate(() => { document.documentElement.dataset.theme = 'dawn' })
    await setWindow(1220, 780)
    await closeInspector()
    await clearSelection()
    await win.getByRole('button', { name: '列表视图', exact: true }).click()
    setTasks(structuredClone(savedTasks.slice(0, 8)))
    await waitCount(8)
    await win.locator('.task-table section').evaluate(node => { node.scrollTop = 0 })
    await win.locator('[data-task-select="101"]').click()
    await closeInspector()
    await win.locator('[data-task-select="102"]').click({ modifiers: ['Meta'] })
    await win.locator('[data-task-select="103"]').click({ modifiers: ['Meta'] })
    await trigger.waitFor({ timeout: 4000 })
    const selectedIds = [101, 102, 103]
    const sheetIds = await win.locator('[data-selection-preview-sheet]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.selectionPreviewSheet)))
    assert.ok(sheetIds.length >= 2 && sheetIds.length <= 3 && sheetIds.every(id => selectedIds.includes(id)), 'The stack only depicts real selected files')
    await win.mouse.move(8, 8)
    const sheetSelector = `[data-selection-preview-sheet="${sheetIds[1]}"]`
    const beforeFan = await win.locator(sheetSelector).evaluate(node => getComputedStyle(node).transform)
    const hoverSampler = await startSampler(sheetSelector, 600)
    const beforeCommands = mutations().length
    await trigger.hover()
    const hoverFrames = await hoverSampler.finish()
    const afterFan = await win.locator(sheetSelector).evaluate(node => getComputedStyle(node).transform)
    assert.notEqual(afterFan, beforeFan, 'Hover visibly fans out the selected-file sheets')
    assert.ok(hoverFrames.some(frame => frame.transform !== beforeFan && frame.transform !== afterFan), 'The stack must produce a real intermediate transform frame')
    assert.equal(mutations().length, beforeCommands, 'Hover cannot run a batch command')
    await capture('19-selection-stack-hover')

    const openSampler = await startSampler('[data-selection-preview-popup]', 460, { waitForChange: true })
    await trigger.click()
    await popup.waitFor({ timeout: 4000 })
    const openFrames = await openSampler.finish()
    const actualIds = await exactSelectedRows(selectedIds)
    for (const id of selectedIds) assert.ok((await win.locator(`[data-selection-preview-item="${id}"]`).innerText()).includes(savedTasks.find(task => task.id === id).filename), 'Every drawer row uses the real task filename')
    assert.ok(openFrames.length > 2 && openFrames.some(frame => frame.opacity > 0 && frame.opacity < 1), 'Opening the drawer has a visible intermediate frame')
    const dialogCount = await win.getByRole('dialog').count()
    await rows.first().click()
    for (const key of ['Enter', 'Space', 'Delete', 'ArrowDown']) await win.keyboard.press(key)
    assert.equal(await popup.isVisible(), true, 'Inspecting a selected file cannot dismiss or execute the selection')
    await exactSelectedRows(selectedIds)
    assert.equal(await win.getByRole('dialog').count(), dialogCount, 'Drawer keystrokes cannot open a delete confirmation behind the popup')
    assert.equal(mutations().length, beforeCommands, 'Read-only file inspection cannot pause, resume, restart or delete downloads')
    await capture('19-selection-preview-files')
    await closeDrawer()
    checks.push({ name: 'Selected-file stack fans through intermediate frames, opens exact files, and returns focus without batch actions', passed: true, actualIds, hoverFrames, openFrames })

    const activeAction = win.locator('[data-hero-content="100"] [data-hero-toggle]')
    await activeAction.click()
    await waitPending()
    pausePending = true
    assert.equal(await toolbar.getAttribute('aria-busy'), 'true')
    assert.equal(await trigger.isEnabled(), true, 'Read-only selected-file inspection stays available while a command awaits its receipt')
    assert.ok((await toolbar.locator('.selection-buttons button').evaluateAll(nodes => nodes.map(node => node.disabled))).every(Boolean), 'All batch mutation and clear controls stay disabled while busy')
    const busyCommandCount = mutations().length
    await trigger.click()
    await popup.waitFor({ timeout: 4000 })
    await exactSelectedRows(selectedIds)
    await capture('19-selection-preview-busy')
    await closeDrawer()
    assert.equal(mutations().length, busyCommandCount, 'Opening the busy drawer cannot duplicate the pending command')
    settle(true)
    pausePending = false
    await win.waitForFunction(() => document.querySelector('[aria-label="批量任务操作"]')?.getAttribute('aria-busy') === 'false', null, { timeout: 4000 })
    checks.push({ name: 'Selected-file inspection remains available during a real pending receipt while batch actions stay disabled', passed: true })

    await clearSelection()
    setTasks(savedTasks)
    await waitCount(savedTasks.length)
    await win.locator('.task-table section').evaluate(node => { node.scrollTop = 0 })
    await win.locator('[data-task-select="101"]').click()
    await closeInspector()
    await win.locator('[data-task-select="101"]').focus()
    await win.keyboard.press('Meta+a')
    await trigger.waitFor({ timeout: 4000 })
    await win.waitForFunction(count => document.querySelector('[data-selection-preview-trigger]')?.textContent.replace(/,/g, '').includes(String(count)), savedTasks.length, { timeout: 4000 })
    const largeCommandCount = mutations().length
    await trigger.click()
    await popup.waitFor({ timeout: 4000 })
    await win.locator('[data-selection-preview-item="100"]').waitFor({ timeout: 4000 })
    const scrollEvidence = []
    for (const fraction of [0, .3, .7, 1]) {
      await list.evaluate((node, fraction) => { node.scrollTop = (node.scrollHeight - node.clientHeight) * fraction }, fraction)
      if (fraction === 1) await win.locator(`[data-selection-preview-item="${savedTasks.at(-1).id}"]`).waitFor({ timeout: 4000 })
      else if (fraction > 0) await win.waitForFunction(({ fraction, count }) => {
        const ids = [...document.querySelectorAll('[data-selection-preview-item]')].map(node => Number(node.dataset.selectionPreviewItem))
        return ids.length > 0 && Math.max(...ids) >= 100 + count * fraction - 40
      }, { fraction, count: savedTasks.length }, { timeout: 4000 })
      const sample = await list.evaluate(node => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
        ids: [...node.querySelectorAll('[data-selection-preview-item]')].map(row => Number(row.dataset.selectionPreviewItem)) }))
      assert.ok(sample.ids.length > 0 && sample.ids.length < 80, 'Even 2000 selected tasks keep fewer than 80 drawer rows mounted')
      scrollEvidence.push(sample)
    }
    const lastId = savedTasks.at(-1).id
    const updatedName = '已选文件实时更新.zip'
    setTasks(savedTasks.map(task => task.id === lastId ? { ...task, filename: updatedName, title: updatedName, status: 'error' } : task))
    await win.waitForFunction(({ lastId, name }) => document.querySelector(`[data-selection-preview-item="${lastId}"]`)?.textContent.includes(name), { lastId, name: updatedName }, { timeout: 4000 })
    assert.ok(await rows.count() < 80)
    assert.equal(mutations().length, largeCommandCount, 'Scrolling and snapshot updates cannot execute selected tasks')
    await capture('19-selection-preview-2000-last')
    await closeDrawer()
    checks.push({ name: '2000 selected files scroll continuously to the last item with bounded mounted rows and live snapshot content', passed: true, scrollEvidence })

    await setWindow(740, 680)
    await win.evaluate(() => { document.documentElement.dataset.theme = 'walnut' })
    await win.getByRole('searchbox', { name: '搜索下载任务', exact: true }).focus()
    await win.mouse.move(8, 8)
    const reducedSheet = '[data-selection-preview-sheet]'
    const reversalSampler = await startSampler(reducedSheet, 580)
    await trigger.hover()
    await win.waitForTimeout(65)
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await win.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches, null, { timeout: 4000 })
    const reversalFrames = await reversalSampler.finish()
    const reducedCss = await win.locator(reducedSheet).first().evaluate(node => ({ transition: getComputedStyle(node).transitionDuration, runningAnimations: node.getAnimations().filter(animation => animation.playState === 'running').length }))
    // The app's global accessibility rule keeps 0.01ms durations so native
    // transition completion events still fire; this is below a display frame.
    assert.ok(reducedCss.transition.split(',').every(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000) <= .011), 'A live reduction preference ends visible sheet transitions')
    assert.equal(reducedCss.runningAnimations, 0)
    assert.equal(new Set(reversalFrames.slice(-5).map(frame => frame.transform)).size, 1, 'The reduced-motion stack settles instead of retaining an interrupted animation')
    const reducedOpenSampler = await startSampler('[data-selection-preview-popup]', 340, { waitForChange: true })
    await trigger.click()
    await popup.waitFor({ timeout: 4000 })
    const reducedOpenFrames = await reducedOpenSampler.finish()
    assert.ok(reducedOpenFrames.length && reducedOpenFrames.at(-1).opacity === 1 && reducedOpenFrames.every(frame => frame.opacity === 0 || frame.opacity === 1), 'Reduced-motion opening displays the drawer without intermediate opacity animation')
    const geometry = await popup.evaluate(node => {
      const box = node.getBoundingClientRect(), list = node.querySelector('[data-selection-preview-list]')
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight,
        listOverflow: list ? list.scrollWidth - list.clientWidth : null, pageOverflow: document.documentElement.scrollWidth - innerWidth }
    })
    assert.ok(geometry.left >= -1 && geometry.top >= -1 && geometry.right <= geometry.viewportWidth + 1 && geometry.bottom <= geometry.viewportHeight + 1, 'The selected-file drawer stays entirely inside a 740×680 window')
    assert.ok(geometry.listOverflow <= 1 && geometry.pageOverflow <= 1, 'Narrow selected-file content cannot cause horizontal overflow')
    assert.equal(mutations().length, largeCommandCount)
    await capture('19-selection-preview-narrow-reduced')
    await closeDrawer()
    checks.push({ name: 'Selected-file drawer responds to reduced motion during hover and fits a narrow window with Escape focus return', passed: true, geometry, reducedCss, reversalFrames, reducedOpenFrames })
  } finally {
    // Restore the exact task snapshot and list state expected by the existing
    // file-component cases, including after a failed assertion.
    if (pausePending) { settle(false); pausePending = false }
    if (await popup.isVisible().catch(() => false)) { await win.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {}) }
    if (await toolbar.isVisible().catch(() => false)) {
      await win.waitForFunction(() => !document.querySelector('[aria-label="批量任务操作"]')?.getAttribute('aria-busy') || document.querySelector('[aria-label="批量任务操作"]')?.getAttribute('aria-busy') === 'false', null, { timeout: 4000 }).catch(() => {})
      await clearSelection()
    }
    setTasks(savedTasks)
    await waitCount(savedTasks.length)
    await win.emulateMedia({ reducedMotion: savedUI.reduced ? 'reduce' : 'no-preference' })
    await win.evaluate(theme => { if (theme) document.documentElement.dataset.theme = theme }, savedUI.theme)
    await setWindow(...windowSize)
    await closeInspector()
    const sidebar = win.getByRole('button', { name: '切换侧栏', exact: true })
    if (savedUI.sidebar && await sidebar.getAttribute('aria-expanded') !== savedUI.sidebar) await sidebar.click()
    await win.locator('.task-table section').evaluate((node, top) => { node.scrollTop = top }, savedUI.scrollTop)
    await win.getByRole('searchbox', { name: '搜索下载任务', exact: true }).focus()
  }
}
