import { _electron as electron } from 'playwright'
import { qaLaunchOptions } from './qa-env.mjs'

const started = performance.now()
const issues = []
const app = await electron.launch(qaLaunchOptions('douyin-access'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})

await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, {
  timeout: 15_000
})
await win.keyboard.press('Meta+n')
await win.getByPlaceholder('粘贴下载链接或整段分享口令...').fill(
  'https://www.douyin.com/video/7662339530070410737'
)

const outcome = await Promise.race([
  win.getByText('选择清晰度').waitFor({ timeout: 100_000 }).then(() => 'formats'),
  win.getByRole('button', { name: '使用 Chrome 会话重试' }).waitFor({ timeout: 100_000 }).then(() => 'browser-session'),
  win.getByText('暂时没有解析到可下载的清晰度').waitFor({ timeout: 100_000 }).then(() => 'probe-failed')
])
const diagnostic = await win.evaluate(() => window.ndm?.request('probeMedia', {
  url: 'https://www.douyin.com/video/7662339530070410737'
}))

console.log(JSON.stringify({
  outcome,
  elapsedMs: Math.round(performance.now() - started),
  spinnerVisible: await win.getByText('正在解析清晰度与音视频轨…').isVisible().catch(() => false),
  diagnostic,
  issues
}))
await app.close()
