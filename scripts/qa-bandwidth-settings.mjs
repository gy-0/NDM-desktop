import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const options = qaLaunchOptions('bandwidth-settings')
const rendererErrors = []
let app

try {
  app = await electron.launch(options)
  const win = await app.firstWindow()
  win.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(message.text())
  })
  win.on('pageerror', (error) => rendererErrors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await waitForLive(win)

  await win.getByRole('button', { name: '设置' }).click()
  const settings = win.locator('div.absolute.inset-0.z-30').filter({
    has: win.getByRole('navigation', { name: '设置分类' })
  })
  await settings.getByRole('button', { name: '下载', exact: true }).click()
  const group = settings.getByRole('group', { name: '全局带宽限速' })
  const custom = settings.getByRole('textbox', { name: '自定义全局带宽，每秒 MB' })
  const fiveMegabytes = group.getByRole('button', { name: '5 MB/s', exact: true })
  const tenMegabytes = group.getByRole('button', { name: '10 MB/s', exact: true })
  await custom.waitFor({ state: 'visible' })

  const before = await engineSettings(win)
  await custom.fill('1..2')
  await custom.press('Enter')
  await win.waitForFunction(() => document.querySelector('#bandwidth-settings-status')?.textContent?.includes('大于 0'))
  const afterInvalid = await engineSettings(win)
  if (afterInvalid.bandwidthLimitBytesPerSecond !== before.bandwidthLimitBytesPerSecond) {
    throw new Error(`invalid custom limit reached the engine: ${JSON.stringify({ before, afterInvalid })}`)
  }
  if (await custom.getAttribute('aria-invalid') !== 'true') {
    throw new Error('invalid custom limit was not exposed to assistive technology')
  }

  await custom.fill('3.5')
  await fiveMegabytes.click()
  await win.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return reply.settings?.bandwidthLimitBytesPerSecond === 5_242_880
  })
  await win.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((button) =>
    button.textContent === '5 MB/s' && button.getAttribute('aria-pressed') === 'true'
  ))
  if (await fiveMegabytes.getAttribute('aria-pressed') !== 'true') {
    throw new Error('preset did not win over the focused custom field')
  }

  await custom.fill('2.5')
  await custom.press('Enter')
  await win.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return reply.settings?.bandwidthLimitBytesPerSecond === 2_621_440
  })
  await win.waitForFunction(() => document.querySelector('#bandwidth-settings-status')?.textContent === '')
  if (await custom.getAttribute('aria-invalid') !== 'false') {
    throw new Error('valid custom limit stayed marked invalid')
  }

  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live')
  await tenMegabytes.click()
  await win.waitForFunction(() => document.querySelector('#bandwidth-settings-status')?.textContent?.includes('未能保存'))
  if (await tenMegabytes.getAttribute('aria-pressed') !== 'false') {
    throw new Error('failed bandwidth save changed the visible selection')
  }
  if (await custom.inputValue() !== '2.5') throw new Error('failed bandwidth save discarded the custom value')
  if (await custom.getAttribute('aria-invalid') !== 'false') {
    throw new Error('engine failure incorrectly marked a valid custom value as malformed')
  }
  if (await group.getAttribute('aria-describedby') !== 'bandwidth-settings-status') {
    throw new Error('bandwidth save failure was not associated with the control group')
  }
  if (await group.getAttribute('aria-busy') !== 'false') throw new Error('bandwidth controls stayed busy after failure')
  if (await tenMegabytes.isDisabled()) throw new Error('bandwidth controls stayed disabled after failure')

  const screenshotPath = process.env.NDM_QA_SCREENSHOT ?? '/tmp/ndm-bandwidth-settings-error.png'
  await settings.screenshot({ path: screenshotPath })
  if (rendererErrors.length) throw new Error(`renderer errors: ${JSON.stringify(rendererErrors)}`)

  console.log(JSON.stringify({
    invalidCustomValue: {
      preservedEngineSetting: true,
      accessibleError: true
    },
    presetOverridesFocusedCustomValue: true,
    savedCustomBytesPerSecond: 2_621_440,
    disconnectedSave: {
      isolatedHostPID: isolatedHost.pid,
      parentPID: isolatedHost.parentPID,
      preservedVisibleSelection: true,
      controlGroupReenabled: true,
      accessibleError: true,
      screenshotPath
    },
    rendererErrors
  }))
} finally {
  await app?.close().catch(() => {})
}

async function waitForLive(win) {
  await win.waitForFunction(async () => {
    if (await window.ndm?.status() !== 'live') return false
    try {
      return (await window.ndm.request('ping'))?.ok === true
    } catch {
      return false
    }
  }, undefined, { timeout: 15_000 })
}

async function engineSettings(win) {
  const reply = await win.evaluate(() => window.ndm.request('getSettings'))
  if (!reply?.settings) throw new Error('engine settings were unavailable')
  return reply.settings
}

function findIsolatedHost(parentPID, port) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  for (const row of rows.split('\n')) {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const candidateParent = Number(match[2])
    const command = match[3]
    if (candidateParent !== parentPID || !command.includes('/NDMHost')) continue
    if (command.includes('/Applications/NDM.app/')) throw new Error(`refusing to touch production host: ${row}`)
    const listeners = execFileSync('/usr/sbin/lsof', [
      '-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN'
    ], { encoding: 'utf8' })
    if (!listeners.includes(`:${port} (LISTEN)`)) continue
    return { pid, parentPID: candidateParent, command }
  }
  throw new Error(`isolated NDMHost child not found for Electron PID ${parentPID} on port ${port}`)
}
