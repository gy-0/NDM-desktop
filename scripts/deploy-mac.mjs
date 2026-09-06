#!/usr/bin/env node
// 一键部署 NDM 到 /Applications（macOS）
// 流程：优雅退出旧实例 → 打包(build + electron-builder + 签名) → 覆盖 → 启动
import { spawnSync, execSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  console.error('deploy-app 仅支持 macOS')
  process.exit(1)
}

const SRC_APP = resolve('dist/mac-arm64/NDM.app')
const APP_PATH = '/Applications/NDM.app'
const HOST_BIN = process.env.NDM_SOURCE
  ? resolve(process.env.NDM_SOURCE, '.build/release/NDMHost')
  : resolve(process.env.HOME ?? '~', 'NDM/.build/release/NDMHost')
const MAX_WAIT = 15

const sh = (cmd) => {
  try {
    // stdout must be piped: with stdio:'ignore' execSync returns an empty
    // buffer, which silently made every running-check pass.
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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
  // 0. 引擎新鲜度：electron-builder 从 ../NDM/.build/release 拷贝 NDMHost，
  //    但不会替你重编 Swift。二进制比 Swift 源码最新提交旧，说明打包会把
  //    旧引擎带进包里（曾导致 Cookie header 被旧 NDMHost 丢弃）。
  if (existsSync(HOST_BIN)) {
    const latestSourceCommitTime = Number(
      sh('git -C ../NDM log -1 --format=%ct || true').split('\n').pop() || 0
    ) * 1000
    const binaryTime = statSync(HOST_BIN).mtimeMs
    if (latestSourceCommitTime > binaryTime) {
      console.log('→ NDMHost 二进制落后于 Swift 源码，先重编 swift build -c release ...')
      run('swift', ['build', '-c', 'release'], { cwd: resolve(process.env.HOME ?? '~', 'NDM'), stdio: 'inherit' })
    } else {
      console.log('→ NDMHost 二进制不落后于 Swift 源码，跳过重编')
    }
  } else {
    console.log('→ 未找到 NDMHost 二进制，先重编 swift build -c release ...')
    run('swift', ['build', '-c', 'release'], { cwd: resolve(process.env.HOME ?? '~', 'NDM'), stdio: 'inherit' })
  }

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
    // 覆盖安装前最后确认：绝不能在进程仍持有旧 bundle 时替换它。
    if (isRunning()) {
      console.error('✗ NDM 无法退出（可能有确认弹窗），请手动退出后重试')
      process.exit(1)
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
