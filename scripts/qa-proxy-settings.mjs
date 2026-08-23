import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const options = qaLaunchOptions('proxy-settings')
const errors = []
let app

try {
  app = await electron.launch(options)
  const win = await app.firstWindow()
  win.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  win.on('pageerror', (error) => errors.push(error.message))
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await waitForLive(win)

  await win.getByRole('button', { name: '设置' }).click()
  const settings = win.locator('aside').filter({ hasText: 'Beta 计划' })
  const http = settings.getByRole('textbox', { name: 'HTTP / HTTPS 代理', exact: true })
  const socks = settings.getByRole('textbox', { name: 'SOCKS5 代理', exact: true })
  await http.waitFor({ state: 'visible' })
  await socks.waitFor({ state: 'visible' })

  const before = await engineSettings(win)
  await http.fill('proxy.example.com:65536')
  await http.press('Enter')
  await win.waitForFunction(() => document.querySelector('#http-proxy')?.getAttribute('aria-invalid') === 'true')
  const invalidState = await engineSettings(win)
  if (invalidState.httpProxyHost !== before.httpProxyHost || invalidState.httpProxyPort !== before.httpProxyPort) {
    throw new Error(`invalid endpoint reached the engine: ${JSON.stringify({ before, invalidState })}`)
  }
  const portError = await settings.locator('#http-proxy-error').textContent()
  if (!portError?.includes('1–65535')) throw new Error(`missing port error: ${portError}`)

  await http.fill('[::1]:7890')
  await http.press('Enter')
  await win.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return reply.settings?.httpProxyHost === '::1' &&
      reply.settings?.httpProxyPort === 7890 &&
      reply.settings?.httpProxyEnabled === true
  })
  if (await http.inputValue() !== '[::1]:7890') throw new Error(`IPv6 display was not normalized: ${await http.inputValue()}`)

  await socks.fill('proxy.example.com')
  await socks.press('Enter')
  await win.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return reply.settings?.socksProxyHost === 'proxy.example.com' &&
      reply.settings?.socksProxyPort === 1080 &&
      reply.settings?.socksProxyEnabled === true
  })

  await http.fill('')
  await http.press('Enter')
  await socks.fill('')
  await socks.press('Enter')
  await win.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return !reply.settings?.httpProxyHost && !reply.settings?.socksProxyHost
  })

  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live')
  await http.fill('127.0.0.1:7890')
  await http.press('Enter')
  await win.waitForFunction(() => document.querySelector('#http-proxy-error')?.textContent?.includes('未能保存'))
  if (await http.inputValue() !== '127.0.0.1:7890') throw new Error('failed save discarded the entered endpoint')
  if (await http.getAttribute('aria-invalid') !== 'true') throw new Error('failed save was not exposed as invalid')
  if (await http.isDisabled()) throw new Error('proxy field stayed disabled after failed save')
  const screenshotPath = process.env.NDM_QA_SCREENSHOT ?? '/tmp/ndm-proxy-settings-error.png'
  await settings.screenshot({ path: screenshotPath })

  if (errors.length) throw new Error(`renderer errors: ${JSON.stringify(errors)}`)
  console.log(JSON.stringify({
    labels: ['HTTP / HTTPS 代理', 'SOCKS5 代理'],
    invalidPortPreservedSettings: true,
    ipv6: { display: '[::1]:7890', host: '::1', port: 7890, enabled: true },
    socksDefaultPort: 1080,
    clearedAfterQA: true,
    disconnectedSave: {
      isolatedHostPID: isolatedHost.pid,
      parentPID: isolatedHost.parentPID,
      keptEnteredValue: true,
      accessibleError: true,
      inputReenabled: true,
      screenshotPath
    },
    rendererErrors: errors
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
  return reply.settings ?? {}
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
