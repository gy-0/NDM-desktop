import { _electron as electron } from 'playwright'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const options = qaLaunchOptions('settings-persistence')
let firstApp
let secondApp
try {
  firstApp = await electron.launch(options)
  const firstWindow = await firstApp.firstWindow()
  await firstWindow.waitForLoadState('domcontentloaded')
  await completeOnboarding(firstWindow)
  await waitForLive(firstWindow)

  await firstWindow.getByRole('button', { name: '设置' }).click()
  const settings = firstWindow.locator('aside').filter({ hasText: 'Beta 计划' })
  await settings.getByRole('button', { name: /雾昼/ }).click()
  await settings.getByRole('button', { name: '8', exact: true }).click()
  await settings.getByRole('button', { name: '5 MB/s', exact: true }).click()
  const categoryFolders = settings.getByRole('switch', { name: /按文件类型分类保存/ })
  if (await categoryFolders.getAttribute('aria-checked') !== 'true') await categoryFolders.click()

  await firstWindow.waitForFunction(async () => {
    const reply = await window.ndm.request('getSettings')
    return reply.settings?.maxConnections === 8 &&
      reply.settings?.bandwidthLimitBytesPerSecond === 5_242_880 &&
      reply.settings?.useCategoryFolders === true
  }, undefined, { timeout: 10_000 })
  const beforeRestart = await readState(firstWindow)
  await firstApp.close()
  firstApp = undefined

  secondApp = await electron.launch(options)
  const secondWindow = await secondApp.firstWindow()
  await secondWindow.waitForLoadState('domcontentloaded')
  await waitForLive(secondWindow)
  const afterRestart = await readState(secondWindow)

  if (afterRestart.theme !== 'dawn' || afterRestart.title !== 'NDM · 雾昼') {
    throw new Error(`theme did not survive restart: ${JSON.stringify(afterRestart)}`)
  }
  if (afterRestart.settings.maxConnections !== 8 ||
      afterRestart.settings.bandwidthLimitBytesPerSecond !== 5_242_880 ||
      afterRestart.settings.useCategoryFolders !== true) {
    throw new Error(`engine settings did not survive restart: ${JSON.stringify(afterRestart.settings)}`)
  }

  console.log(JSON.stringify({ beforeRestart, afterRestart }))
} finally {
  await firstApp?.close().catch(() => {})
  await secondApp?.close().catch(() => {})
}

async function waitForLive(win) {
  await win.waitForFunction(async () => {
    if (await window.ndm?.status() !== 'live') return false
    try {
      return (await window.ndm.request('ping'))?.ok === true
    } catch {
      return false
    }
  }, undefined, {
    timeout: 15_000
  })
}

async function readState(win) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await win.evaluate(async () => ({
      theme: localStorage.getItem('ndm-theme'),
      title: document.title,
      settings: (await window.ndm.request('getSettings')).settings
    })).catch(() => null)
    if (state) return state
    await win.waitForTimeout(250)
  }
  throw new Error('engine settings were unavailable after reconnect')
}
