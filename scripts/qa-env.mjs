import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

const APP = '/Users/gaoyuan/NDM-desktop'

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

  let steps = 0
  while (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: /^(继续|开始使用)$/ }).click()
    steps += 1
  }
  return steps
}
