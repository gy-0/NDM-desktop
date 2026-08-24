import { _electron as electron } from 'playwright'
import { qaLaunchOptions } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('onboarding-gallery'))
const main = await app.firstWindow()
const consoleIssues = []

const watchConsole = (page) => {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleIssues.push(`[${message.type()}] ${message.text()}`)
    }
  })
}

watchConsole(main)

try {
  await main.waitForLoadState('domcontentloaded')
  const onboarding = main.getByRole('dialog', { name: '欢迎使用 NDM' })
  await onboarding.waitFor({ state: 'visible', timeout: 5_000 })
  await main.waitForTimeout(300)

  await main.screenshot({ path: '/tmp/ndm-onboarding-1.png' })
  const initialAction = await onboarding.getByRole('button', { name: '继续' }).evaluate((button) => {
    const style = getComputedStyle(button)
    return { background: style.backgroundColor, color: style.color, opacity: style.opacity }
  })
  console.log('onboarding action:', JSON.stringify(initialAction))
  await onboarding.getByRole('button', { name: '继续' }).click()
  await main.waitForTimeout(300)
  await main.screenshot({ path: '/tmp/ndm-onboarding-2.png' })

  if (await onboarding.getByRole('button', { name: '继续' }).isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: '继续' }).click()
    await main.waitForTimeout(300)
  }
  await main.screenshot({ path: '/tmp/ndm-onboarding-final.png' })

  const finalCopy = await onboarding.textContent()
  console.log('onboarding final:', finalCopy?.includes('数据保存在本机'))
  await onboarding.getByRole('button', { name: '开始使用' }).click()

  const galleryOpened = app.waitForEvent('window', { timeout: 5_000 })
  await main.evaluate(() => window.ndm?.openGallery?.())
  await galleryOpened
  const windows = app.windows()
  const gallery = windows.find((page) => page.url().includes('gallery=1'))
  if (!gallery) throw new Error(`gallery window did not open: ${windows.map((page) => page.url()).join(', ')}`)
  watchConsole(gallery)
  await gallery.waitForLoadState('domcontentloaded')
  await gallery.getByText('外观预览', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  await gallery.waitForTimeout(800)
  await gallery.screenshot({ path: '/tmp/ndm-gallery-neutral.png' })

  const galleryState = await gallery.evaluate(() => ({
    cards: document.querySelectorAll('article').length,
    background: getComputedStyle(document.body).backgroundColor,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }))
  console.log('gallery:', JSON.stringify(galleryState))
  console.log('console issues:', consoleIssues.length ? consoleIssues.join('\n') : 'none')
  if (galleryState.cards !== 3 || galleryState.horizontalOverflow || consoleIssues.length) {
    throw new Error(`onboarding/gallery QA failed: ${JSON.stringify({ galleryState, consoleIssues })}`)
  }
  console.log('DONE')
} finally {
  await app.close().catch(() => undefined)
}
