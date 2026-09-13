import assert from 'node:assert/strict'

const timeout = 1800
const roundedHeights = frames => new Set(frames.map(frame => Math.round(frame.height)))
const hasIntermediateHeight = (frames, from, to) => {
  const low = Math.min(from, to), high = Math.max(from, to)
  return frames.some(frame => frame.height > low + 2 && frame.height < high - 2)
}

/** Runs only against the caller's already isolated Electron fixture. */
export async function runWorkspaceMotionCases({ app, win, startSampler, capture, checks }) {
  const wait = (predicate, argument) => win.waitForFunction(predicate, argument, { timeout })
  const nextFrame = () => win.evaluate(() => new Promise(requestAnimationFrame))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))
  await win.emulateMedia({ reducedMotion: 'no-preference' })
  await wait(() => matchMedia('(prefers-reduced-motion: no-preference)').matches)
  await win.mouse.move(30, 30)

  const row = win.locator('[data-task-select="101"]')
  await row.click({ timeout })
  const inspector = win.locator('#task-inspector')
  await inspector.waitFor({ state: 'visible', timeout })
  const summary = inspector.locator('summary').filter({ hasText: /^下载设置$/ })
  assert.equal(await summary.count(), 1, 'The paused fixture exposes one download-settings disclosure')
  const details = summary.locator('..')
  const panelId = await summary.getAttribute('aria-controls')
  assert.ok(panelId, 'Native summary must identify its disclosure content')
  const detailsSelector = `#task-inspector details:has(> summary[aria-controls=${JSON.stringify(panelId)}])`
  const panel = details.locator('.animated-disclosure-content')
  const waitOpen = open => wait(({ selector, open }) => document.querySelector(selector)?.open === open, { selector: detailsSelector, open })
  assert.equal(await details.evaluate(element => element.tagName), 'DETAILS')
  assert.equal(await details.evaluate(element => element.open), false)
  await summary.scrollIntoViewIfNeeded({ timeout })
  await summary.focus({ timeout })
  const closedHeight = (await details.boundingBox()).height

  const opening = await startSampler(detailsSelector, 440)
  await summary.press('Enter', { timeout })
  await waitOpen(true)
  const openTrace = await opening.finish()
  const openHeight = (await details.boundingBox()).height
  assert.ok(openHeight > closedHeight + 30, 'Opening reveals actual settings content')
  assert.ok(hasIntermediateHeight(openTrace, closedHeight, openHeight), 'Opening must include actual intermediate native details heights')
  assert.equal(await summary.getAttribute('aria-expanded'), 'true')
  assert.equal(await panel.evaluate(element => element.inert), false)
  assert.equal(await summary.evaluate(element => element === document.activeElement), true, 'Enter keeps focus on the native summary')
  await capture('05-inspector-disclosure-open')

  const closing = await startSampler(detailsSelector, 440)
  await summary.press('Space', { timeout })
  await waitOpen(false)
  assert.equal(await summary.getAttribute('aria-expanded'), 'false')
  assert.equal(await panel.evaluate(element => element.inert), true, 'Closing content becomes inert before its pixels disappear')
  assert.equal(await panel.getAttribute('aria-hidden'), 'true')
  await panel.locator('button').first().evaluate(element => element.focus())
  assert.equal(await panel.evaluate(element => element.contains(document.activeElement)), false, 'An outgoing control cannot regain focus')
  const closeTrace = await closing.finish()
  assert.ok(hasIntermediateHeight(closeTrace, openHeight, closedHeight), 'Closing must include actual intermediate native details heights')
  assert.ok(Math.abs((await details.boundingBox()).height - closedHeight) < 2)

  await summary.focus({ timeout })
  const reversing = await startSampler(detailsSelector, 560)
  await summary.press('Enter', { timeout })
  await win.waitForTimeout(40)
  await summary.press('Enter', { timeout })
  await win.waitForTimeout(35)
  await summary.press('Enter', { timeout })
  await waitOpen(true)
  const reverseTrace = await reversing.finish()
  assert.ok(roundedHeights(reverseTrace).size > 3, 'Rapid reversal still paints real intermediate sizes')
  assert.equal(await details.count(), 1, 'Reversals do not duplicate disclosure content')
  assert.ok(Math.abs((await details.boundingBox()).height - openHeight) < 2)

  // Change the live preference during a close, then prove a reduced-motion
  // open is already at its terminal height on the next rendered frame.
  try {
    await summary.press('Enter', { timeout })
    await win.waitForTimeout(40)
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await wait(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
    await nextFrame()
    await waitOpen(false)
    assert.ok(Math.abs((await details.boundingBox()).height - closedHeight) < 2, 'Enabling reduced motion finishes the in-flight close')
    const reduced = await startSampler(detailsSelector, 240)
    await summary.press('Enter', { timeout })
    await waitOpen(true)
    await nextFrame()
    const immediateHeight = (await details.boundingBox()).height
    assert.ok(Math.abs(immediateHeight - openHeight) < 2, 'Reduced-motion expansion is immediate')
    const reducedTrace = await reduced.finish()
    assert.equal(hasIntermediateHeight(reducedTrace, closedHeight, openHeight), false, 'Reduced-motion traces contain only endpoints')
    await capture('05-inspector-disclosure-reduced')
    checks.push({ name: 'Inspector: native disclosure height, keyboard, reversal, inert close and live reduced motion', passed: true, closedHeight, openHeight, openTrace, closeTrace, reverseTrace, reducedTrace })
  } finally {
    await win.emulateMedia({ reducedMotion: 'no-preference' })
    await wait(() => matchMedia('(prefers-reduced-motion: no-preference)').matches)
  }

  await inspector.getByRole('button', { name: '关闭任务详情', exact: true }).click({ timeout })
  await inspector.waitFor({ state: 'hidden', timeout })
  await row.focus({ timeout })
  await win.keyboard.press('Escape')
  assert.equal(await row.getAttribute('aria-pressed'), 'false', 'Palette case begins without task selection')
  await win.locator('#ndm-search').focus({ timeout })
  await win.keyboard.press('Meta+k')
  const palette = win.getByRole('dialog', { name: '快速操作', exact: true })
  await palette.waitFor({ state: 'visible', timeout })
  const input = palette.getByRole('combobox', { name: '搜索操作', exact: true })
  await wait(() => document.activeElement?.getAttribute('aria-label') === '搜索操作')
  const listbox = palette.getByRole('listbox', { name: '可用操作', exact: true })
  const highlight = palette.locator('[data-command-highlight]')
  assert.equal(await highlight.count(), 1)
  await wait(() => document.querySelector('[data-command-highlight]')?.getAttribute('data-visible') === 'true')
  const activeAssociation = async () => {
    const result = await input.evaluate(element => {
      const id = element.getAttribute('aria-activedescendant')
      const selected = id ? document.getElementById(id) : null
      return { id, selected: selected?.getAttribute('aria-selected'), role: selected?.getAttribute('role'), command: selected?.getAttribute('data-command-id'), selectedCount: element.closest('[data-command-palette]')?.querySelectorAll('[role="option"][aria-selected="true"]').length }
    })
    assert.ok(result.id)
    assert.equal(result.role, 'option')
    assert.equal(result.selected, 'true')
    assert.equal(result.selectedCount, 1)
    return result
  }
  const initialActive = await activeAssociation()
  const moving = await startSampler('[data-command-highlight]', 440)
  await input.press('ArrowDown', { timeout })
  const nextActive = await activeAssociation()
  assert.notEqual(nextActive.id, initialActive.id)
  await win.waitForTimeout(35)
  await input.press('ArrowDown', { timeout })
  await win.waitForTimeout(35)
  await input.press('ArrowUp', { timeout })
  const finalActive = await activeAssociation()
  assert.equal(finalActive.id, nextActive.id)
  const highlightTrace = await moving.finish()
  assert.ok(new Set(highlightTrace.map(frame => frame.transform)).size > 3, 'Keyboard reversals move one continuous highlight through intermediate positions')
  assert.equal(await highlight.count(), 1)
  const alignment = await input.evaluate(element => {
    const option = document.getElementById(element.getAttribute('aria-activedescendant'))
    const mark = element.closest('[data-command-palette]').querySelector('[data-command-highlight]')
    const target = option.getBoundingClientRect(), actual = mark.getBoundingClientRect()
    return { x: actual.x - target.x, y: actual.y - target.y, width: actual.width - target.width, height: actual.height - target.height }
  })
  assert.ok(Object.values(alignment).every(delta => Math.abs(delta) < 2), 'Highlight settles on the selected option in local layout coordinates')

  const hoverTarget = await listbox.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return [...element.querySelectorAll('[role="option"]')].filter(option => !option.disabled && option.getAttribute('aria-selected') !== 'true').map(option => ({ id: option.getAttribute('data-command-id'), box: option.getBoundingClientRect() })).filter(({ box }) => box.top >= bounds.top && box.bottom <= bounds.bottom).map(({ id, box }) => ({ id, x: box.left + box.width / 2, y: box.top + box.height / 2 }))[0]
  })
  assert.ok(hoverTarget, 'Fixture supplies another fully visible enabled command')
  const scrollBefore = await listbox.evaluate(element => element.scrollTop)
  const hovering = await startSampler('[data-command-highlight]', 320)
  await win.mouse.move(hoverTarget.x, hoverTarget.y)
  await wait(id => document.querySelector('[data-command-palette] [role="option"][aria-selected="true"]')?.getAttribute('data-command-id') === id, hoverTarget.id)
  const hoverTrace = await hovering.finish()
  assert.equal((await activeAssociation()).command, hoverTarget.id)
  assert.equal(await listbox.evaluate(element => element.scrollTop), scrollBefore, 'Pointer highlighting never scrolls the results')
  assert.ok(new Set(hoverTrace.map(frame => frame.transform)).size > 2, 'Pointer switching also paints a continuous highlight')
  await capture('06-command-palette-highlight')
  await win.mouse.move(30, 30)

  const fullHeight = (await listbox.boundingBox()).height
  const shrinking = await startSampler('[data-command-palette] [role="listbox"]', 480, { waitForChange: true })
  await input.fill('ndm-no-such-command-不存在', { timeout })
  await palette.getByText('没有找到这个操作', { exact: true }).waitFor({ state: 'visible', timeout })
  assert.equal(await input.getAttribute('aria-activedescendant'), null)
  assert.equal(await highlight.getAttribute('data-visible'), 'false')
  await input.press('Enter', { timeout })
  assert.equal(await palette.isVisible(), true, 'An empty result set cannot execute')
  const shrinkTrace = await shrinking.finish()
  const emptyHeight = (await listbox.boundingBox()).height
  assert.ok(fullHeight > emptyHeight + 20, 'Empty results shrink the actual scroll region')
  assert.ok(hasIntermediateHeight(shrinkTrace, fullHeight, emptyHeight), 'Search shrink paints intermediate result-region heights')
  await capture('06-command-palette-empty')

  const expanding = await startSampler('[data-command-palette] [role="listbox"]', 480, { waitForChange: true })
  await palette.getByRole('button', { name: '清空操作搜索', exact: true }).click({ timeout })
  const expandTrace = await expanding.finish()
  assert.ok(hasIntermediateHeight(expandTrace, emptyHeight, fullHeight), 'Clearing search expands actual result height smoothly')
  assert.equal(await input.evaluate(element => element === document.activeElement), true)
  assert.ok(Math.abs((await listbox.boundingBox()).height - fullHeight) < 2)
  const geometry = await palette.evaluate(element => {
    const dialog = element.getBoundingClientRect(), footer = element.lastElementChild.getBoundingClientRect()
    const results = element.querySelector('[role="listbox"]')
    return { top: dialog.top, bottom: dialog.bottom, right: dialog.right, viewportHeight: innerHeight, viewportWidth: innerWidth, footerBottom: footer.bottom, horizontalOverflow: results.scrollWidth - results.clientWidth }
  })
  assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight + 1)
  assert.ok(geometry.right <= geometry.viewportWidth + 1 && geometry.footerBottom <= geometry.viewportHeight + 1)
  assert.ok(geometry.horizontalOverflow <= 1)

  for (const query of ['搜索', 'SEARCH']) {
    await input.fill(query, { timeout })
    assert.equal((await activeAssociation()).command, 'search')
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await input.dispatchEvent('keydown', { key: 'Process', code: 'Enter' })
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 })
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true })
    assert.equal(await palette.isVisible(), true, `${query}: IME and repeated Enter must not execute`)
    assert.equal(await input.evaluate(element => element === document.activeElement), true)
  }
  await capture('06-command-palette-search')
  await input.press('Enter', { timeout })
  await palette.waitFor({ state: 'hidden', timeout })
  await wait(() => document.activeElement?.id === 'ndm-search')
  checks.push({ name: 'Command palette: continuous highlight, active descendant, pointer scroll, result height, IME and safe search execution', passed: true, initialActive, finalActive, alignment, fullHeight, emptyHeight, geometry, highlightTrace, hoverTrace, shrinkTrace, expandTrace })
}
