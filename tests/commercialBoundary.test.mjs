import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const composer = fs.readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')
const inspector = fs.readFileSync('src/renderer/src/components/Inspector.tsx', 'utf8')
const settings = fs.readFileSync('src/renderer/src/components/Settings.tsx', 'utf8')
const commercialization = fs.readFileSync('src/renderer/src/lib/commercialization.ts', 'utf8')

test('commercial draft stays in source but is disabled for the open Beta', () => {
  assert.match(commercialization, /COMMERCIALIZATION_DRAFT_ENABLED = false/)
  assert.match(app, /COMMERCIALIZATION_DRAFT_ENABLED \? \(/)
  assert.match(app, /<ProModal/)
  assert.equal(fs.existsSync('src/renderer/src/components/ProModal.tsx'), true)
  assert.equal(fs.existsSync('src/renderer/src/components/ProChip.tsx'), true)
  assert.equal(fs.existsSync('src/renderer/src/lib/license.ts'), true)
})

test('Beta does not enforce draft playlist or ultra-HD locks', () => {
  assert.match(composer, /COMMERCIALIZATION_DRAFT_ENABLED && collectionScope === 'all'/)
  assert.match(composer, /COMMERCIALIZATION_DRAFT_ENABLED && requiresPro\('playlist'\)/)
  assert.match(composer, /COMMERCIALIZATION_DRAFT_ENABLED && isUltraHD\(fmt\)/)
  assert.match(settings, /当前版本开放全部已实现能力/)
  assert.match(settings, /基础下载、合集和清晰度选择都不会被锁住/)
})

test('unimplemented conversion and cloud draft stays hidden', () => {
  assert.match(inspector, /COMMERCIALIZATION_DRAFT_ENABLED \? \(/)
  assert.match(inspector, /格式转换与音频提取/)
  assert.match(inspector, /下载历史云同步/)
})
