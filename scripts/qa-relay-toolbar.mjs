// Chrome action popups are independent targets, absent from Playwright pages().
import { writeFileSync } from 'node:fs'

export async function inspectToolbar(context, worker, filePath, { dark = false } = {}) {
  await worker.evaluate(() => chrome.action.openPopup())
  const cdp = await context.browser().newBrowserCDPSession()
  let target
  for (let attempt = 0; attempt < 30; attempt++) {
    const targets = await cdp.send('Target.getTargets')
    target = targets.targetInfos.find(item => item.url.endsWith('/popup.html') && !item.attached)
    if (target) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!target) throw new Error('Actual toolbar popup target missing')

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
  let nextID = 0
  async function send(method, params = {}) {
    const id = ++nextID
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cdp.off('Target.receivedMessageFromTarget', receive)
        reject(new Error(`Toolbar CDP timeout: ${method}`))
      }, 10_000)
      function receive(event) {
        if (event.sessionId !== sessionId) return
        const message = JSON.parse(event.message)
        if (message.id !== id) return
        clearTimeout(timer)
        cdp.off('Target.receivedMessageFromTarget', receive)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
      cdp.on('Target.receivedMessageFromTarget', receive)
    })
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
    return result
  }

  try {
    if (dark) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await new Promise(resolve => setTimeout(resolve, 500))
    const dimensions = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({outerWidth,outerHeight,innerWidth,innerHeight,body:document.body.getBoundingClientRect().toJSON(),scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText})',
      returnByValue: true
    })
    const shot = await send('Page.captureScreenshot')
    writeFileSync(filePath, Buffer.from(shot.data, 'base64'))
    return JSON.parse(dimensions.result.value)
  } finally {
    await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {})
    await cdp.detach()
  }
}
