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

  return {
    args: ['.', `--user-data-dir=${root}/electron`],
    cwd: APP,
    env: {
      ...process.env,
      NDM_HOST_PORT: String(hostPort),
      NDM_BRIDGE_PORT: String(bridgePort),
      NDM_SUPPORT_DIR: engineRoot
    }
  }
}
