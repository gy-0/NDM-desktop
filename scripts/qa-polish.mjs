import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { qaLaunchOptions } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('polish', { seedHistory: true }))
const win = await app.firstWindow()
const issues = []
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})
await win.evaluate(() => {
  localStorage.setItem('ndm-theme', 'dawn')
  localStorage.setItem('ndm.onboarded', '1')
  location.reload()
})
await win.waitForSelector('ul li', { timeout: 15_000 })
await win.waitForTimeout(500)
console.log('theme:', await win.evaluate(() => document.documentElement.dataset.theme))

const filters = ['已完成', '视频', '已暂停', '全部']
const timings = []
for (const label of filters) {
  const started = performance.now()
  await win.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) }).click()
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  timings.push({ label, ms: Math.round((performance.now() - started) * 10) / 10 })
}
const filterState = await win.evaluate(() => ({
  mountedRows: document.querySelectorAll('ul li').length,
  inspectors: document.querySelectorAll('aside').length - 1,
  maxRowHeight: Math.max(...[...document.querySelectorAll('ul li')].map((row) => row.getBoundingClientRect().height)),
  listHeader: [...document.querySelectorAll('main div')].some((element) => element.textContent?.includes('最近活动优先')),
  unexplainedStatusRails: document.querySelectorAll('[data-status-rail]').length
}))
console.log('filter timings:', JSON.stringify(timings))
console.log('filter state:', JSON.stringify(filterState))
if (filterState.unexplainedStatusRails !== 0) throw new Error('task rows still expose unexplained status rails')
if (filterState.listHeader) throw new Error('static recent-activity label is still present')

const schedulableRow = win.locator('[data-task-state="incomplete"], [data-task-state="paused"], [data-task-state="waiting"], [data-task-state="error"]').first()
if (await schedulableRow.count()) {
  await schedulableRow.locator('button').first().click()
  const detailState = await win.evaluate(() => ({
    downloadLink: document.body.innerText.includes('下载链接'),
    storage: document.body.innerText.includes('存储位置'),
    dateInput: document.querySelectorAll('input[aria-label="预约日期，日月年"]').length,
    timeInput: document.querySelectorAll('input[aria-label="预约时间，时和分"]').length,
    nativeDateTime: document.querySelectorAll('input[type="datetime-local"]').length,
    duplicateRedownload: [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '重下')
  }))
  console.log('detail state:', JSON.stringify(detailState))
  if (!detailState.downloadLink || !detailState.storage) throw new Error('detail copy fields are missing')
  if (detailState.dateInput !== 1 || detailState.timeInput !== 1 || detailState.nativeDateTime !== 0) {
    throw new Error('day/month/year schedule controls are not active')
  }
  if (detailState.duplicateRedownload) throw new Error('duplicate redownload action is still present')
}

const hoverRow = win.locator('[data-task-state]').nth(1)
await hoverRow.hover()
await win.waitForTimeout(180)
const rowHoverState = await hoverRow.evaluate((element) => {
  const copyButton = element.querySelector('button[title="复制链接"]')
  const actionStrip = copyButton?.parentElement
  return {
    rowShadow: getComputedStyle(element).boxShadow,
    actionOpacity: actionStrip ? getComputedStyle(actionStrip).opacity : null,
    actionShadow: actionStrip ? getComputedStyle(actionStrip).boxShadow : null,
    actionBackground: actionStrip ? getComputedStyle(actionStrip).backgroundImage : null
  }
})
console.log('row hover:', JSON.stringify(rowHoverState))
if (rowHoverState.actionOpacity !== '1' || (rowHoverState.actionShadow && rowHoverState.actionShadow !== 'none')) {
  throw new Error('row hover actions still look like a floating shadow panel')
}
writeFileSync('/tmp/ndm-polish-row-hover.png', await win.screenshot())

const list = win.locator('main section').last()
await list.evaluate((element) => { element.scrollTop = element.scrollHeight })
await win.waitForTimeout(250)
const bottomRow = win.locator('ul li').last()
await bottomRow.click({ button: 'right', position: { x: 120, y: 20 } })
const menu = win.getByRole('menu')
await menu.waitFor()
const menuBounds = await menu.boundingBox()
const viewport = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
await win.keyboard.press('ArrowDown')
const keyboardNavigation = await menu.evaluate((element) => ({
  highlighted: element.querySelectorAll('[data-highlighted]').length,
  activeRole: document.activeElement?.getAttribute('role')
}))
const lastItem = win.getByRole('menuitem', { name: /移到废纸篓/ })
await lastItem.hover()
await win.waitForTimeout(120)
const hover = await lastItem.evaluate((element) => ({
  background: getComputedStyle(element).backgroundColor,
  color: getComputedStyle(element).color,
  matchesHover: element.matches(':hover'),
  className: element.className,
  hitTarget: document.elementFromPoint(
    element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2,
    element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2
  )?.closest('[role="menuitem"]') === element
}))
console.log('bottom menu:', JSON.stringify({ menuBounds, viewport, keyboardNavigation, hover }))
writeFileSync('/tmp/ndm-polish-context-bottom.png', await win.screenshot())
await win.keyboard.press('Escape')

await win.keyboard.press('Meta+,')
await win.waitForTimeout(400)
const volumeSlider = win.getByLabel('提示音音量')
if (await volumeSlider.count() !== 1) throw new Error('sound volume control is missing')
const settingsScroll = win.locator('aside').nth(1).locator('.scroll-quiet')
await settingsScroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
await win.waitForTimeout(250)
writeFileSync('/tmp/ndm-polish-settings-extension.png', await win.screenshot())

console.log('console issues:', issues.length ? issues.join(' | ') : 'none')
await app.close()
