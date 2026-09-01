// QA: verify the transitions.dev motion work end-to-end in a real Electron window.
// Covers: onboarding t-page-slide (directional), Settings t-toggle bounce,
// Inspector inspector-split entrance, thumbnail reveal class, context-menu
// dropdown curve, stylesheet coverage of all installed transitions.
// ProModal (t-modal / error-shake / success-check) is gated behind
// COMMERCIALIZATION_DRAFT_ENABLED=false in Beta; verified via CSS coverage below.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const issues = []
const notes = []

const payload = Buffer.alloc(1024 * 1024, 0x63)
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length })
  res.end(payload)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const url = `http://127.0.0.1:${address.port}/motion-qa-a.mp4`

const app = await electron.launch(qaLaunchOptions('motion3'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error') issues.push(message.text())
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(400)

// 0. Stylesheet coverage: every installed transition present in the bundle
const cssCoverage = await win.evaluate(() => {
  const text = [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText)
      } catch {
        return []
      }
    })
    .join('\n')
  return {
    tokens: text.includes('--duration-fast'),
    tModal: text.includes('.t-modal'),
    tToast: text.includes('.t-toast'),
    tToggle: text.includes('.t-toggle'),
    shake: text.includes('t-input-shake'),
    check: text.includes('.t-success-check'),
    pageSlide: text.includes('.t-page-slide'),
    dropdownCurve: text.includes('--dropdown-pre-scale'),
    panel: text.includes('.inspector-split'),
    skel: text.includes('.t-skel-content')
  }
})
notes.push({ step: 'css-coverage', ...cssCoverage })

// 1. Onboarding page-slide: click through steps, sample the slide mid-flight
const dialog = win.getByRole('dialog', { name: '欢迎使用 NDM' })
if (await dialog.isVisible().catch(() => false)) {
  const slideBefore = await win.evaluate(() => {
    const el = document.querySelector('.t-page-slide')
    if (!el) return null
    return { dir: el.dataset.dir, pages: el.querySelectorAll('.t-page').length }
  })
  notes.push({ step: 'page-slide-structure', ...slideBefore })
  // Click 继续 and sample the outgoing page while the 250ms slide runs
  await dialog.getByRole('button', { name: /^继续$/ }).click()
  await win.waitForTimeout(90)
  const midFlight = await win.evaluate(() => {
    const pages = [...document.querySelectorAll('.t-page')]
    return pages.map((p) => ({
      active: p.classList.contains('is-active'),
      opacity: Number(getComputedStyle(p).opacity).toFixed(2),
      blur: getComputedStyle(p).filter !== 'none'
    }))
  })
  notes.push({ step: 'page-slide-midflight', midFlight })
  await win.screenshot({ path: '/tmp/ndm-motion-page-slide.png' })
}
const stepsWalked = await completeOnboarding(win, { exerciseAllSteps: true })
notes.push({ step: 'onboarding-done', stepsWalked })

// Wait for engine, then add one real task
for (let i = 0; i < 60; i++) {
  if ((await win.evaluate(() => window.ndm?.status()).catch(() => 'down')) === 'live') break
  if (i === 59) throw new Error('engine did not become live')
  await win.waitForTimeout(250)
}
await win.keyboard.press('Meta+n')
await win.locator('input[placeholder*="下载链接"]').fill(url)
await win.keyboard.press('Enter')
await win.waitForFunction(
  async (target) => {
    const reply = await window.ndm?.request('list')
    return (reply?.tasks ?? []).some((item) => item.filename === target)
  },
  'motion-qa-a.mp4',
  { timeout: 15_000 }
)
await win.waitForTimeout(300)

// 2. Select the row → Inspector opens as a split pane
await win.locator('text=motion-qa-a.mp4').first().click()
await win.waitForTimeout(60)
const inspectorState = await win.evaluate(() => {
  const aside = document.querySelector('aside.inspector-split')
  if (!aside) return { present: false }
  const cs = getComputedStyle(aside)
  return { present: true, animationName: cs.animationName, duration: cs.animationDuration }
})
notes.push({ step: 'inspector-panel', ...inspectorState })
await win.waitForTimeout(500)
await win.screenshot({ path: '/tmp/ndm-motion-inspector.png' })

// Close inspector, right-click the row → context menu opens on dropdown curve
await win.keyboard.press('Escape').catch(() => {})
await win.waitForTimeout(200)
await win.locator('text=motion-qa-a.mp4').first().click({ button: 'right' })
await win.waitForTimeout(120)
const menuState = await win.evaluate(() => {
  const popup = document.querySelector('.t-dropdown')
  if (!popup) return { present: false }
  const cs = getComputedStyle(popup)
  return { present: true, transformOrigin: cs.transformOrigin, durations: cs.transitionDuration }
})
notes.push({ step: 'context-menu', ...menuState })
if (menuState.present) await win.screenshot({ path: '/tmp/ndm-motion-contextmenu.png' })
await win.keyboard.press('Escape')

// 3. Settings toggles: flip one, confirm t-toggle + data-on + is-init
await win.getByRole('button', { name: '设置' }).click()
await win.waitForTimeout(350)
const switches = win.getByRole('switch')
const switchCount = await switches.count()
if (switchCount > 0) {
  const first = switches.first()
  const clsBefore = await first.getAttribute('class')
  const before = await first.getAttribute('data-on')
  await first.click()
  await win.waitForTimeout(100)
  const after = await first.getAttribute('data-on')
  notes.push({
    step: 'toggle',
    switchCount,
    hasTToggle: /t-toggle/.test(clsBefore),
    before,
    after,
    flipped: before !== after,
    isInitAfterClick: await first.evaluate((el) => el.classList.contains('is-init'))
  })
  await win.screenshot({ path: '/tmp/ndm-motion-settings.png' })
} else {
  notes.push({ step: 'toggle', switchCount })
}

// Cleanup the seeded task
await win.evaluate(async () => {
  const reply = await window.ndm?.request('list')
  for (const item of reply?.tasks ?? []) {
    if (item.filename === 'motion-qa-a.mp4') {
      await window.ndm?.request('remove', { taskID: item.id, deleteFile: true })
    }
  }
}).catch(() => {})

server.close()
writeFileSync('/tmp/ndm-motion-qa-result.json', JSON.stringify({ issues, notes }, null, 2))
console.log(JSON.stringify({ issues, notes }, null, 2))
await app.close()
