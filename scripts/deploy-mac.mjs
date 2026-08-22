#!/usr/bin/env node
// 一键部署 NDM 到 /Applications（macOS）
// 流程：优雅退出旧实例 → 打包(build + electron-builder + 签名) → 覆盖 → 启动
import { spawnSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.platform !== 'darwin') {
  console.error('deploy-app 仅支持 macOS')
  process.exit(1)
}

const APP_PATH = '/Applications/NDM.app'
const SRC_APP = resolve('dist/mac-arm64/NDM.app')
const MAX_WAIT = 15

const sh = (cmd) => {
  try {
    return execSync(cmd, { stdio: 'ignore' }).toString().trim()
  } catch {
    return ''
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isRunning = () => sh('pgrep -f "/Applications/NDM.app" || true').length > 0

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(' ')} 失败 (exit ${r.status ?? 'signal'})`)
    process.exit(r.status ?? 1)
  }
}

async function main() {
  // 1. 优雅退出正在运行的 NDM（让下载任务有机会暂停/保存，而非强杀）
  if (isRunning()) {
    console.log('→ 检测到正在运行的 NDM，尝试优雅退出...')
    sh('osascript -e \'quit app "NDM"\'')
    for (let i = 0; i < MAX_WAIT; i++) {
      if (!isRunning()) break
      await sleep(1000)
    }
    if (isRunning()) {
      console.log('→ 优雅退出超时，强制结束残留进程...')
      sh('pkill -f "/Applications/NDM.app"')
      await sleep(2000)
    }
  } else {
    console.log('→ 没有运行中的 NDM，跳过退出步骤')
  }

  // 2. 打包（build + electron-builder + 签名）
  console.log('→ 打包中：build + electron-builder + 签名 ...')
  run('npm', ['run', 'package'])

  // 3. 部署到 /Applications
  if (!existsSync(SRC_APP)) {
    console.error(`✗ 找不到构建产物：${SRC_APP}`)
    process.exit(1)
  }
  const version = sh(
    `/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${SRC_APP}/Contents/Info.plist"`
  )
  console.log('→ 部署到 /Applications/NDM.app ...')
  if (existsSync(APP_PATH)) run('rm', ['-rf', APP_PATH])
  run('cp', ['-R', SRC_APP, APP_PATH])

  // 4. 启动
  console.log('→ 启动 NDM ...')
  run('open', [APP_PATH])
  console.log(`✅ 已部署并启动 NDM.app (${version || '最新版'}) 到 /Applications`)
}

main()
