import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const engine = fs.readFileSync('src/main/engine.ts', 'utf8')
const main = fs.readFileSync('src/main/index.ts', 'utf8')
const preload = fs.readFileSync('src/preload/index.ts', 'utf8')
const store = fs.readFileSync('src/renderer/src/lib/store.ts', 'utf8')
const viteEnv = fs.readFileSync('src/renderer/src/vite-env.d.ts', 'utf8')

test('engine broadcasts failure reasons over the status channel', () => {
  assert.match(engine, /type EngineStatusPayload = \{[\s\S]*?status: EngineStatus[\s\S]*?engineError\?: string/)
  assert.match(engine, /engineError: string \| undefined/)
  assert.match(engine, /window\.webContents\.send\('engine:status', \{ status, engineError: error \}\)/)
  assert.match(engine, /NDMHost 二进制缺失，已尝试 swift run/)
  assert.match(engine, /NDMHost 进程已退出（code \$\{code \?\? 'unknown'\}）/)
  assert.match(engine, /NDMHost 启动失败（\$\{error\.message/)
  assert.match(engine, /端口 \$\{PORT\} 连接失败（\$\{reason\}）/)
})

test('status invoke and window bootstrap hand the payload (not a bare string)', () => {
  assert.match(main, /ipcMain\.handle\('engine:status', \(\) => \(\{ status: engine\.status, engineError: engine\.engineError \}\)\)/)
  assert.match(main, /window\.webContents\.send\('engine:status', \{ status: engine\.status, engineError: engine\.engineError \}\)/)
  assert.match(main, /ipcMain\.handle\('engine:error', \(\) => engine\.engineError \?\? null\)/)
  assert.match(main, /ipcMain\.handle\('engine:retry'/)
  assert.match(main, /engine\.retry\(\)/)
})

test('preload normalizes legacy bare-string status events without breaking consumers', () => {
  // Public status() call stays a plain status string for existing consumers.
  assert.match(preload, /return typeof reply === 'string' \? reply : reply\.status/)
  assert.match(preload, /typeof payload === 'string'[\s\S]*?handler\(\{ status: payload, engineError: undefined \}\)/)
  assert.match(preload, /getEngineError: \(\) => ipcRenderer\.invoke\('engine:error'\)/)
  assert.match(preload, /retryEngine: \(\) => ipcRenderer\.invoke\('engine:retry'\)/)
  assert.match(viteEnv, /onStatus: \(handler: \(payload: EngineStatusPayload\) => void\)/)
  assert.match(viteEnv, /getEngineError: \(\) => Promise<string \| null>/)
})

test('renderer store surfaces the engine failure reason', () => {
  assert.match(store, /let engineError: string \| undefined/)
  assert.match(store, /export function getEngineError\(\): string \| undefined/)
  assert.match(store, /normalized\.status === 'live'[\s\S]*?\? undefined/)
  assert.match(store, /api\.getEngineError\?\.\(\)\.then/)
  assert.match(store, /export async function retryEngine/)
})