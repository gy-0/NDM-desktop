import { fileURLToPath as repositoryFileURLToPath } from 'node:url'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

const APP = repositoryFileURLToPath(new URL('..', import.meta.url))

export function qaLaunchOptions(name, { seedHistory = false } = {}) {
  const slot = process.pid % 5_000
  const hostPort = 54_000 + slot
  const bridgePort = 59_000 + slot
  const root = `/tmp/ndm-${name}-qa-${process.pid}`
  const engineRoot = `${root}/engine`

  mkdirSync(engineRoot, { recursive: true })
  if (seedHistory) {
    const source = `${homedir()}/Library/Application Support/dev.ndm.open/NeatDB.db`
    if (existsSync(source)) copyFileSync(source, `${engineRoot}/NeatDB.db`)
  }

  const packagedExecutable = process.env.NDM_QA_APP_PATH?.trim()

  return {
    ...(packagedExecutable
      ? {
          executablePath: packagedExecutable,
          args: [`--user-data-dir=${root}/electron`]
        }
      : { args: ['.', `--user-data-dir=${root}/electron`] }),
    cwd: APP,
    env: {
      ...process.env,
      NDM_HOST_PORT: String(hostPort),
      NDM_BRIDGE_PORT: String(bridgePort),
      NDM_DISABLE_LEGACY_BRIDGE: '1',
      NDM_SUPPORT_DIR: engineRoot
    }
  }
}

export async function completeOnboarding(win, { exerciseAllSteps = false } = {}) {
  const dialog = win.getByRole('dialog', { name: '欢迎使用 NDM' })
  if (!await dialog.isVisible().catch(() => false)) return 0

  if (!exerciseAllSteps) {
    await dialog.getByRole('button', { name: '跳过' }).click()
    return 1
  }

  const browserSetup = dialog.getByRole('button', { name: '连接浏览器', exact: true })
  let steps = 1
  if (await browserSetup.isVisible().catch(() => false)) {
    await browserSetup.click()
    await dialog.locator('[data-onboarding-step="browser"]').waitFor()
    steps += 1
  }
  await dialog.getByRole('button', { name: '开始使用', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  return steps
}

/**
 * Details-pane sections collapse behind their own summaries ("下载设置" holds
 * connections, the per-task limit and the appointment). Open the named one
 * before reading or driving its content,
 * and leave an already-open one alone (a blind click would close it again).
 */
export async function openInspectorDisclosure(win, label) {
  const summary = win.locator('#task-inspector summary').getByText(label, { exact: true })
  // The pane can mount a beat after whatever opened it (a row click, a finished
  // composer submission), so wait for the summary instead of racing it.
  const appeared = await summary.first().waitFor({ state: 'attached', timeout: 5_000 }).then(() => true).catch(() => false)
  if (!appeared) return false
  const target = summary.first()
  const alreadyOpen = await target.evaluate((element) => element.parentElement instanceof HTMLDetailsElement && element.parentElement.open)
  if (alreadyOpen) return true
  await target.click()
  return true
}

export async function openDownloadSettings(win) {
  return await openInspectorDisclosure(win, '下载设置')
}
