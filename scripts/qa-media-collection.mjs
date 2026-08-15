import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { qaLaunchOptions } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('media-collection'))
const win = await app.firstWindow()
const issues = []
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, {
  timeout: 15_000
})

const url = 'https://www.youtube.com/playlist?list=PL0Xy5cYzhAy9BiKIlpQZTFOoeYV5r9nwN'
await win.getByRole('button', { name: '添加下载 +' }).click()
await win.getByPlaceholder(/粘贴下载链接/).fill(url)
await win.getByText(/已识别 \d+ 项/).waitFor({ timeout: 120_000 })
const allScope = win.getByRole('button', { name: /整个合集|前 \d+ 项/ })
await allScope.click()
await win.getByText(/合集预计峰值/).waitFor({ timeout: 12_000 })

const picker = await win.evaluate(() => ({
  collectionSummary: [...document.querySelectorAll('p')].find((node) => /已识别 \d+ 项/.test(node.textContent ?? ''))?.textContent,
  wholeCollectionSelected: [...document.querySelectorAll('button')].some((button) =>
    /整个合集|前 \d+ 项/.test(button.textContent ?? '') && button.className.includes('bg-raised')
  ),
  primaryAction: [...document.querySelectorAll('button')].find((button) => /下载(?:整个合集|前 \d+ 项)/.test(button.textContent ?? ''))?.textContent,
  storageText: [...document.querySelectorAll('span')].find((node) => node.textContent?.includes('合集预计峰值'))?.textContent
}))
writeFileSync('/tmp/ndm-media-collection.png', await win.screenshot())

await win.getByRole('button', { name: /下载(?:整个合集|前 \d+ 项)/ }).click()
await win.waitForFunction(async () => {
  const reply = await window.ndm.request('list')
  return (reply.tasks?.length ?? 0) > 1
}, undefined, { timeout: 30_000 })
await win.waitForTimeout(500)
const tasks = await win.evaluate(async () => (await window.ndm.request('list')).tasks)
const group = win.locator('[data-collection-group]').first()
await group.waitFor({ timeout: 8_000 })

if (!picker.wholeCollectionSelected || !picker.primaryAction || !picker.storageText) {
  throw new Error(`collection picker incomplete: ${JSON.stringify(picker)}`)
}
if (tasks.length < 2 || !tasks.every((task) => task.pageURL === url)) {
  throw new Error(`collection tasks missing provenance: ${JSON.stringify(tasks)}`)
}
if (!tasks.every((task) => /^\d+ - .+\.mp4$/.test(task.filename))) {
  throw new Error(`collection filenames are not ordered: ${JSON.stringify(tasks.map((task) => task.filename))}`)
}
const collectionIDs = new Set(tasks.map((task) => task.collection?.id).filter(Boolean))
if (collectionIDs.size !== 1 || !tasks.every((task) => task.collection?.count === tasks.length)) {
  throw new Error(`collection identity is not stable: ${JSON.stringify(tasks.map((task) => task.collection))}`)
}
if (tasks.map((task) => task.collection?.index).sort((a, b) => a - b).join(',') !== tasks.map((_, index) => index + 1).join(',')) {
  throw new Error('collection indexes are incomplete')
}
const active = tasks.filter((task) => task.status === 'downloading').length
if (active > 1) throw new Error(`collection started ${active} tasks concurrently`)

const groupState = await group.evaluate((element) => ({
  summary: element.textContent,
  expanded: element.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'),
  hasPause: Boolean(element.querySelector('button[aria-label="暂停整个合集"]'))
}))
if (groupState.expanded !== 'false' || !groupState.hasPause || !groupState.summary?.includes(`/${tasks.length} 已完成`)) {
  throw new Error(`collapsed collection summary is incomplete: ${JSON.stringify(groupState)}`)
}
writeFileSync('/tmp/ndm-media-collection-list.png', await win.screenshot())

await group.locator('button[aria-expanded]').click()
await win.getByText(/^01 - /).waitFor()
if (await group.locator('button[aria-expanded]').getAttribute('aria-expanded') !== 'true') {
  throw new Error('collection did not expand')
}
await group.locator('button[aria-expanded]').click()

await group.getByRole('button', { name: '暂停整个合集' }).click()
await win.waitForFunction(async () => {
  const rows = (await window.ndm.request('list')).tasks ?? []
  return rows.length > 1 && rows.every((task) => !['downloading', 'waiting'].includes(task.status))
}, undefined, { timeout: 20_000 })
const resumeGroup = group.getByRole('button', { name: /继续整个合集|重试失败项/ })
await resumeGroup.waitFor({ timeout: 8_000 })
await resumeGroup.click()
await win.waitForFunction(async () => {
  const rows = (await window.ndm.request('list')).tasks ?? []
  return rows.some((task) => task.status === 'downloading' || task.status === 'waiting')
}, undefined, { timeout: 12_000 })
await group.getByRole('button', { name: '暂停整个合集' }).click()
await win.waitForTimeout(500)

await win.evaluate(async (tasks) => {
  for (const task of tasks) {
    if (task.status === 'downloading') await window.ndm.request('pause', { taskID: task.id })
    await window.ndm.request('remove', { taskID: task.id, deleteFile: true })
  }
}, tasks)

console.log(JSON.stringify({ picker, taskCount: tasks.length, active, groupState, issues }))
await app.close()
