import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-offset-native-'))
const bundle = resolve('native/.build/debug/NDMEngineTests.xctest')
assert.ok(existsSync(bundle), 'Build native tests first')
function launch(mode) {
  // XCTest can dump its environment on invocation errors. Never inherit secrets.
  const child = spawn('/usr/bin/xcrun', ['xctest', '-XCTest', 'NDMEngineTests.OffsetStorageProcessTests/testProcessFixture', bundle], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: tmpdir(),
      NDM_OFFSET_QA_ROOT: root, NDM_OFFSET_QA_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal, output }))
  })
  return { child, done }
}
let current
try {
  current = launch('crash')
  for (let i = 0; i < 150 && !existsSync(join(root, 'ready')); i++) {
    if (current.child.exitCode !== null) throw new Error((await current.done).output)
    await delay(100)
  }
  assert.ok(existsSync(join(root, 'ready')), 'Child never checkpointed')
  current.child.kill('SIGKILL')
  assert.equal((await current.done).signal, 'SIGKILL')
  current = launch('resume')
  const timeout = setTimeout(() => current.child.kill('SIGKILL'), 20000)
  const result = await current.done
  clearTimeout(timeout)
  assert.equal(result.code, 0, result.output)
  const data = readFileSync(join(root, 'result.bin'))
  assert.equal(data.length, 32 * 131072)
  const expected = Buffer.alloc(data.length)
  for (let i = 0; i < expected.length; i++) expected[i] = i % 251
  const hash = data => createHash('sha256').update(data).digest('hex')
  assert.equal(hash(data), hash(expected))
  const allocated = directory => readdirSync(directory).reduce((sum, name) => {
    const path = join(directory, name), info = statSync(path)
    return sum + (info.isDirectory() ? allocated(path) : info.blocks * 512)
  }, 0)
  const ownedAllocatedBytes = allocated(root)
  assert.ok(ownedAllocatedBytes < data.length * 1.1, 'Unexpected duplicate storage')
  console.log(JSON.stringify({ passed: true, root, ownedAllocatedBytes, sha256: hash(data), scope: 'native storage backend; not yet integrated into downloader' }))
} finally { if (current?.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGKILL') }
