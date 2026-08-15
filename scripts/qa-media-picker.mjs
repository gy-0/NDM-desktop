import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'

const started = performance.now()
const issues = []
const app = await electron.launch({ args: ['.'], cwd: '/Users/gaoyuan/NDM-desktop' })
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})

await win.waitForLoadState('domcontentloaded')
await win.getByRole('button', { name: '添加下载 +' }).click()
const input = win.getByPlaceholder(/粘贴 HTTP/)
await input.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ')

const result = await Promise.race([
  win.getByText('选择清晰度').waitFor({ timeout: 100_000 }).then(() => 'formats'),
  win.getByText(/暂时没有解析到/).waitFor({ timeout: 100_000 }).then(() => 'error')
])
if (result === 'formats') {
  await win.locator('img[alt="视频缩略图"]').waitFor({ timeout: 8_000 })
}
const state = await win.evaluate(() => ({
  siteLogo: Boolean(document.querySelector('svg[aria-label="YouTube"]')),
  thumbnail: Boolean(document.querySelector('img[alt="视频缩略图"]')),
  selectedFormats: document.querySelectorAll('button.border-copper\\/65').length,
  hasTitle: document.body.innerText.includes('Never Gonna Give You Up')
}))
writeFileSync('/tmp/ndm-media-picker.png', await win.screenshot())
console.log(JSON.stringify({ result, elapsedMs: Math.round(performance.now() - started), state, issues }))
await app.close()
