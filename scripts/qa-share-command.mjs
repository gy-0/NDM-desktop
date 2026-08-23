import { _electron as electron } from 'playwright'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const issues = []
const app = await electron.launch(qaLaunchOptions('share-command'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})

await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, {
  timeout: 15_000
})
await completeOnboarding(win)
await win.waitForTimeout(300)
await win.keyboard.press('Meta+n')
const input = win.getByPlaceholder('粘贴下载链接、磁力链或整段分享口令...')
await input.waitFor()

async function paste(text) {
  await input.evaluate((element, value) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', value)
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    }))
  }, text)
}

await paste('8.93 复制打开抖音，看看【一个很棒的视频】 https://v.douyin.com/iABC123/ 03/07 abc:/')
const fullCommand = {
  value: await input.inputValue(),
  recognized: await win.getByText('已从抖音分享口令中提取链接').isVisible()
}

await input.fill('')
await paste('复制打开：v.douyin.com/iNoScheme/。')
const noScheme = await input.inputValue()

console.log(JSON.stringify({ fullCommand, noScheme, issues }))
await app.close()
