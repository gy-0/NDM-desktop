import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { qaLaunchOptions } from './qa-env.mjs'

const started = performance.now()
const issues = []
const app = await electron.launch(qaLaunchOptions('media-picker'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})

await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, {
  timeout: 15_000
})
await win.getByRole('button', { name: '添加下载 +' }).click()
const input = win.getByPlaceholder(/粘贴下载链接/)
await input.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ')

const result = await Promise.race([
  win.getByText('选择清晰度').waitFor({ timeout: 100_000 }).then(() => 'formats'),
  win.getByText(/暂时没有解析到/).waitFor({ timeout: 100_000 }).then(() => 'error')
])
if (result === 'formats') {
  await win.locator('img[alt="视频缩略图"]').waitFor({ timeout: 8_000 })
  await win.getByText(/预计峰值/).waitFor({ timeout: 8_000 }).catch(() => undefined)
}
const storageContract = result === 'formats'
  ? await win.evaluate(async () => {
      const settings = await window.ndm.request('getSettings')
      const probe = await window.ndm.request('probeMedia', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
      const format = probe.formats?.[0]
      const storage = format ? await window.ndm.request('checkStorage', {
        folderPath: '/Users/gaoyuan/Downloads',
        finalBytes: format.approximateBytes,
        componentBytes: format.componentBytes,
        formatID: format.id,
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        collectionScope: 'current',
        container: 'compatibleMP4'
      }) : null
      return { settings, storage }
    })
  : null
const state = await win.evaluate(() => ({
  siteLogo: Boolean(document.querySelector('svg[aria-label="YouTube"]')),
  thumbnail: Boolean(document.querySelector('img[alt="视频缩略图"]')),
  selectedFormats: document.querySelectorAll('button.border-copper\\/65').length,
  hasTitle: document.body.innerText.includes('Never Gonna Give You Up'),
  hasDeliveryFormat: document.body.innerText.includes('成品格式'),
  hasMP4: document.body.innerText.includes('兼容优先'),
  hasMKV: document.body.innerText.includes('体积更小'),
  subtitleOptions: document.querySelectorAll('select option').length,
  spaceConfidence: document.body.innerText.includes('预计峰值')
}))
await win.getByRole('button', { name: /^选项/ }).click()
const optionState = await win.evaluate(() => ({
  hasDownloadFolder: document.body.innerText.includes('/Users/gaoyuan/Downloads')
}))
if (result === 'formats' && (
  !state.hasDeliveryFormat || !state.hasMP4 || !state.hasMKV ||
  state.subtitleOptions < 1 || !state.spaceConfidence || !optionState.hasDownloadFolder
)) {
  throw new Error(`media picker incomplete: ${JSON.stringify({ state, optionState })}`)
}
writeFileSync('/tmp/ndm-media-picker.png', await win.screenshot())
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.8))
const form = win.locator('form')
await form.evaluate((element) => { element.scrollTop = element.scrollHeight })
const zoomState = await form.evaluate((element) => {
  const primary = [...element.querySelectorAll('button')].find((button) => button.textContent?.includes('开始下载'))
  const bounds = primary?.getBoundingClientRect()
  return {
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
    primaryVisible: Boolean(bounds && bounds.top >= 0 && bounds.bottom <= window.innerHeight)
  }
})
if (!zoomState.primaryVisible || zoomState.overflowY !== 'auto') {
  throw new Error(`composer is not usable at 180% zoom: ${JSON.stringify(zoomState)}`)
}
console.log(JSON.stringify({ result, elapsedMs: Math.round(performance.now() - started), state, optionState, zoomState, storageContract, issues }))
await app.close()
