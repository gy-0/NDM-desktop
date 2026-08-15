import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'

const app = await electron.launch({ args: ['.'], cwd: '/Users/gaoyuan/NDM-desktop' })
const main = await app.firstWindow()
const issues = []
main.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})

await main.waitForSelector('ul li', { timeout: 15_000 })
await main.waitForTimeout(1_000)

const initial = await main.evaluate(() => ({
  mountedRows: document.querySelectorAll('ul li').length,
  scrollTop: document.querySelector('section')?.scrollTop ?? -1,
  totalSize: Number.parseFloat(document.querySelector('ul')?.style.height ?? '0')
}))
console.log('virtual initial:', JSON.stringify(initial))

for (let index = 0; index < 60; index += 1) {
  await main.keyboard.press('ArrowDown')
  await main.waitForTimeout(8)
}
await main.waitForTimeout(300)

const navigated = await main.evaluate(() => ({
  mountedRows: document.querySelectorAll('ul li').length,
  scrollTop: document.querySelector('section')?.scrollTop ?? -1,
  selectedText: document.querySelector('.ring-copper\\/50')?.textContent?.slice(0, 80) ?? null
}))
console.log('virtual navigated:', JSON.stringify(navigated))

await main.evaluate(() => window.ndm?.openGallery?.())
await main.waitForTimeout(1_200)
const gallery = app.windows().find((window) => window !== main)
if (!gallery) throw new Error('Gallery window did not open')
gallery.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})
await gallery.waitForSelector('iframe')
await gallery.waitForTimeout(800)

const previews = await gallery.locator('iframe').evaluateAll((frames) =>
  frames.map((frame) => {
    const url = new URL(frame.src)
    return {
      protocol: url.protocol,
      file: url.pathname.endsWith('/index.html'),
      gallery: url.searchParams.has('gallery'),
      embed: url.searchParams.get('embed'),
      theme: url.searchParams.get('theme'),
      loadedTheme: frame.contentDocument?.documentElement.dataset.theme ?? null
    }
  })
)
console.log('gallery previews:', JSON.stringify(previews))

const image = await gallery.screenshot()
writeFileSync('/tmp/ndm-gallery-virtualized.png', image)
console.log('console issues:', issues.length ? issues.join(' | ') : 'none')

await app.close()
