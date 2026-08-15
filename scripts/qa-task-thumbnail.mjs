import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { qaLaunchOptions } from './qa-env.mjs'

const fixtureRoot = `/tmp/ndm-thumbnail-fixture-${process.pid}`
const filename = '真实预览.png'
mkdirSync(fixtureRoot, { recursive: true })
writeFileSync(
  `${fixtureRoot}/${filename}`,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAHgQCAQqguXQAAAAASUVORK5CYII=', 'base64')
)

const app = await electron.launch(qaLaunchOptions('task-thumbnail'))
const win = await app.firstWindow()
const issues = []
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, {
  timeout: 15_000
})
await win.waitForTimeout(1_500)

const task = await win.evaluate(async ({ fixtureRoot, filename }) => {
  const reply = await window.ndm.request('add', {
    url: 'https://example.com/real-preview.png',
    folderPath: fixtureRoot,
    filename,
    pageTitle: '真实缩略图验收',
    thumbnailURL: 'https://example.com/persisted-preview.png',
    autoStart: false
  })
  return reply.task
}, { fixtureRoot, filename })

if (task.thumbnailURL !== 'https://example.com/persisted-preview.png') {
  throw new Error('thumbnail URL did not survive host persistence')
}

await win.getByText(filename, { exact: true }).click()
const preview = win.locator('img[alt$="的预览图"]')
await preview.waitFor({ timeout: 10_000 })
const state = await preview.evaluate((image) => ({
  source: image.getAttribute('src')?.slice(0, 22),
  width: image.getBoundingClientRect().width,
  height: image.getBoundingClientRect().height,
  outline: getComputedStyle(image.closest('figure')).outlineColor
}))
writeFileSync('/tmp/ndm-task-thumbnail.png', await win.screenshot())
console.log(JSON.stringify({ task: { id: task.id, thumbnailURL: task.thumbnailURL }, state, issues }))
await app.close()
