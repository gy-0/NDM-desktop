import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { connectionOptionsForPlatform } from '../src/renderer/src/lib/platform.ts'

test('connection choices match each platform engine capability', () => {
  assert.deepEqual(connectionOptionsForPlatform(true), [4, 8, 16])
  assert.deepEqual(connectionOptionsForPlatform(false), [4, 8, 16, 32])
})

test('connection setting waits for the engine result and exposes save failures', () => {
  const settings = fs.readFileSync('src/renderer/src/components/Settings.tsx', 'utf8')
  assert.match(settings, /const saved = await updateEngineSettings\(\{ maxConnections: conns \}\)/)
  assert.match(settings, /setEngineSettings\(saved\)/)
  assert.doesNotMatch(settings, /setEngineSettings\(\{ \.\.\.engineSettings, maxConnections: conns \}\)/)
  assert.match(settings, /role="group"[\s\S]*?aria-pressed=/)
  assert.match(settings, /id="connection-setting-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/)
  assert.match(settings, /未能保存连接数。请检查下载引擎后重试。/)
  assert.match(settings, /if \(attempt < 3\)[\s\S]*?setTimeout\(\(\) => loadSettings\(attempt \+ 1\), 400\)/)
  assert.match(settings, /未能读取下载设置。请关闭设置后重试。/)
})

test('download directory changes stay pending until the engine confirms them', () => {
  const settings = fs.readFileSync('src/renderer/src/components/Settings.tsx', 'utf8')
  const handler = settings.match(/const handleSelectFolder[\s\S]*?\n  \}/)
  assert.ok(handler, 'folder handler is present')
  assert.match(handler[0], /const saved = await updateEngineSettings\(\{ downloadDirectory: selected \}\)/)
  assert.match(handler[0], /setEngineSettings\(saved\)/)
  assert.doesNotMatch(handler[0], /setEngineSettings\([^)]*downloadDirectory: selected/)
  assert.match(handler[0], /finally \{[\s\S]*?setSaving\(false\)/)
  assert.match(settings, /id="download-directory-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/)
  assert.match(settings, /未能保存下载目录。请检查目录和下载引擎后重试。/)
})
