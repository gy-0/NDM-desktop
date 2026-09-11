import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

const root = await mkdtemp(join(tmpdir(), 'ndm-preview-'))
const folderPath = join(root, 'downloads')
await mkdir(folderPath)
const payload = Buffer.from('NDM Quick Look keyboard preview\n')
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'content-length': payload.length })
  res.end(req.method === 'HEAD' ? undefined : payload)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const app = await electron.launch(qaLaunchOptions('quick-look'))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await win.waitForFunction(async () => {
    try { return await window.ndm.status() === 'live' && Array.isArray((await window.ndm.request('list'))?.tasks) }
    catch { return false }
  }, undefined, { timeout: 15000 })
  // Observe the actual native call, then forward it to macOS Quick Look.
  await app.evaluate(({ BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows()[0]
    const nativePreview = owner.previewFile.bind(owner)
    globalThis.previewCalls = []
    owner.previewFile = (path) => { globalThis.previewCalls.push(path); nativePreview(path) }
  })
  await win.evaluate(async fields => window.ndm.request('add', fields), {
    url: `http://127.0.0.1:${server.address().port}/preview.txt`,
    filename: 'preview.txt', folderPath, autoStart: true
  })
  const row = win.locator('[data-task-state="complete"] [data-task-select]').filter({ hasText: 'preview.txt' })
  await row.waitFor({ state: 'visible' })
  await row.click()
  const link = win.getByRole('button', { name: '在浏览器中打开下载链接', exact: true })
  const font = await link.locator('span').first().evaluate(el => getComputedStyle(el).fontFamily)
  assert.doesNotMatch(font, /mono/i)
  await row.focus()
  await win.keyboard.press('Space')
  await win.waitForTimeout(500)
  assert.deepEqual(await app.evaluate(() => globalThis.previewCalls), [join(folderPath, 'preview.txt')])
  const outline = await row.evaluate(el => getComputedStyle(el).outlineStyle)
  assert.equal(outline, 'none')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].closeFilePreview())
  await unlink(join(folderPath, 'preview.txt'))
  await row.focus()
  const beforeFailure = await row.boundingBox()
  await win.keyboard.press('Space')
  const notice = win.locator('[data-preview-notice]')
  await notice.waitFor({ state: 'visible' })
  assert.equal(await win.locator('#task-action-status').count(), 0)
  assert.equal((await row.boundingBox()).y, beforeFailure.y)
  await notice.waitFor({ state: 'detached', timeout: 4500 })
  const search = win.locator('#ndm-search')
  await search.focus()
  await win.keyboard.press('Space')
  assert.equal(await search.inputValue(), ' ')
  assert.equal(await app.evaluate(() => globalThis.previewCalls.length), 1)
  console.log(JSON.stringify({ nativePreviewInvoked: true, spaceInInputPreserved: true, rowOutline: outline, detailFont: font, folderPath }))
} finally {
  await app.close()
  server.closeAllConnections()
  server.close()
}
