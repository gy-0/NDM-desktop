import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const options = qaLaunchOptions('proxy-settings')
const errors = []
const processLogs = []
let app

try {
  app = await electron.launch(options)
  app.process().stdout?.on('data', (chunk) => processLogs.push(String(chunk)))
  app.process().stderr?.on('data', (chunk) => processLogs.push(String(chunk)))
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
  await win.waitForFunction(
    () => document.querySelector('[data-proxy-state="http"]')?.textContent === '使用中',
    undefined,
    { timeout: 3_000 }
  ).catch(async () => {
    const evidence = await win.evaluate(async () => ({
      settings: (await window.ndm.request('getSettings')).settings,
      httpState: document.querySelector('[data-proxy-state="http"]')?.textContent,
      socksState: document.querySelector('[data-proxy-state="socks"]')?.textContent,
      httpError: document.querySelector('#http-proxy-error')?.textContent,
      socksError: document.querySelector('#socks-proxy-error')?.textContent
    }))
    throw new Error(`saved HTTP proxy did not update the UI: ${JSON.stringify(evidence)}`)
  })
  if (await settings.locator('[data-proxy-state="http"]').textContent() !== '使用中') {
    throw new Error('HTTP proxy was not presented as active')
  }

  await socks.fill('proxy.example.com')
  await socks.press('Enter')
  await win.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return reply.settings?.socksProxyHost === 'proxy.example.com' &&
      reply.settings?.socksProxyPort === 1080 &&
      reply.settings?.socksProxyEnabled === true &&
      reply.settings?.httpProxyEnabled === false
  })
  await win.waitForFunction(() => document.querySelector('[data-proxy-state="socks"]')?.textContent === '使用中')
  if (await settings.locator('[data-proxy-state="socks"]').textContent() !== '使用中') {
    throw new Error('SOCKS5 proxy was not presented as active after switching')
  }
  const useHTTP = settings.getByRole('button', { name: '使用 HTTP / HTTPS 代理', exact: true })
  await useHTTP.click()
  await win.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return reply.settings?.httpProxyEnabled === true && reply.settings?.socksProxyEnabled === false
  })
  await win.waitForFunction(
    () => document.querySelector('[data-proxy-state="http"]')?.textContent === '使用中',
    undefined,
    { timeout: 3_000 }
  ).catch(async () => {
    const evidence = await win.evaluate(async () => ({
      settings: (await window.ndm.request('getSettings')).settings,
      httpState: document.querySelector('[data-proxy-state="http"]')?.textContent,
      socksState: document.querySelector('[data-proxy-state="socks"]')?.textContent,
      httpError: document.querySelector('#http-proxy-error')?.textContent,
      socksError: document.querySelector('#socks-proxy-error')?.textContent
    }))
    throw new Error(`reactivated HTTP proxy did not update the UI: ${JSON.stringify(evidence)}`)
  })
  if (await settings.locator('[data-proxy-state="http"]').textContent() !== '使用中') {
    throw new Error('saved HTTP proxy did not reactivate')
  }
  const switchScreenshotPath = process.env.NDM_QA_SWITCH_SCREENSHOT ?? '/tmp/ndm-proxy-settings-switch.png'
  await settings.screenshot({ path: switchScreenshotPath })

  await settings.getByRole('button', { name: '停用代理', exact: true }).click()
  await win.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return reply.settings?.httpProxyEnabled === false && reply.settings?.socksProxyEnabled === false
  })
  await settings.getByText('未启用', { exact: true }).waitFor({ state: 'visible' })
  if (await settings.getByText('未启用', { exact: true }).count() !== 1) {
    throw new Error('disabled proxy state was not visible')
  }

  await http.fill('')
  await http.press('Enter')
  await socks.fill('')
  await socks.press('Enter')
  await win.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return !reply.settings?.httpProxyHost && !reply.settings?.socksProxyHost
  })

  const categoryFolders = settings.getByRole('switch', { name: /按文件类型分类保存/ })
  const categoryBeforeFailure = await categoryFolders.getAttribute('aria-checked')
  const isolatedHost = findIsolatedHost(app.process().pid, Number(options.env.NDM_HOST_PORT))
  process.kill(isolatedHost.pid, 'SIGTERM')
  await win.waitForFunction(async () => await window.ndm.status() !== 'live')
  await categoryFolders.click()
  await win.waitForFunction(() => document.querySelector('#category-folders-status')?.textContent?.includes('未能保存'))
  if (await categoryFolders.getAttribute('aria-checked') !== categoryBeforeFailure) {
    throw new Error('failed category-folder save changed the visible switch')
  }
  if (await categoryFolders.isDisabled()) throw new Error('category-folder switch stayed disabled after failed save')
  if (await categoryFolders.getAttribute('aria-describedby') !== 'category-folders-status') {
    throw new Error('category-folder failure was not associated with the switch')
  }
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
    singleActiveProxy: {
      switchedTo: 'socks',
      reactivated: 'http',
      disabledWithoutDeleting: true,
      screenshotPath: switchScreenshotPath
    },
    clearedAfterQA: true,
    disconnectedSave: {
      isolatedHostPID: isolatedHost.pid,
      parentPID: isolatedHost.parentPID,
      keptEnteredValue: true,
      accessibleError: true,
      inputReenabled: true,
      screenshotPath
    },
    categoryFolderFailure: {
      preservedVisibleState: true,
      accessibleError: true,
      switchReenabled: true
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const reply = await win.evaluate(() => window.ndm.request('getSettings')).catch(() => null)
    if (reply?.settings) return reply.settings
    await win.waitForTimeout(100)
  }
  throw new Error(`engine settings stayed unavailable after reconnect: ${processLogs.join('').slice(-2_000)}`)
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
