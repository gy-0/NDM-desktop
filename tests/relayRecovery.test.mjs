import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const main = fs.readFileSync('src/main/index.ts', 'utf8')
const engine = fs.readFileSync('src/main/engine.ts', 'utf8')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

test('packaged app registers the ndm URL scheme for Relay recovery', () => {
  assert.deepEqual(pkg.build.protocols, [{ name: 'NDM', schemes: ['ndm'] }])
  assert.match(main, /app\.on\('open-url'/)
  assert.match(main, /setAsDefaultProtocolClient\(APP_PROTOCOL\)/)
})

test('Relay focus events from NDMHost reach the main-window controller', () => {
  assert.match(main, /new EngineClient\(showMainWindow\)/)
  assert.match(engine, /message\.op === 'focusApp'/)
  assert.match(engine, /this\.onFocusRequest\(\)/)
})
