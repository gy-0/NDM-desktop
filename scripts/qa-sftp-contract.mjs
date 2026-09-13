import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'

const python = process.env.NDM_SFTP_FIXTURE_PYTHON
if (!python) throw new Error('Set NDM_SFTP_FIXTURE_PYTHON to an isolated Python environment with Paramiko 4.0.0.')
const binary = resolve('native/Vendor/Tools/aria2-next')
const expectedHash = process.arch === 'arm64' ? 'c36268f2ab67614ad8737586adab7fc1e1df85e0aef55421bd45f778f0868343' : 'c94d4bed9f1d8270320e17d3af1fa72d5fd4040efd5ee8a87c6d75d47aa6c5b4'
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), expectedHash)
const root = await mkdtemp(join(tmpdir(), 'ndm-sftp-contract-'))
const fixture = spawn(python, ['scripts/qa-sftp-fixture.py', '--bytes', '1048576', '--delay', '0.005'], { stdio: ['ignore', 'pipe', 'pipe'] })
const fixtureExit = once(fixture, 'exit')
let metadata
const children = new Set()
try {
  const metadataPath = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('SFTP fixture did not start')), 15000)
    fixture.stdout.on('data', chunk => {
      buffer += String(chunk)
      if (!buffer.includes('\n')) return
      try { clearTimeout(timer); resolve(JSON.parse(buffer.split('\n')[0]).metadataPath) }
      catch { reject(new Error('Invalid fixture readiness')) }
    })
    fixture.once('error', reject)
    fixture.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture exited before readiness')) })
  })
  metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  const events = async () => (await readFile(join(metadata.root, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const run = async (name, pin, password) => {
    const destination = join(root, name)
    const child = spawn(binary, ['--no-conf=true', '--no-netrc=true', '--max-tries=1', '--retry-wait=0', '--timeout=10', '--connect-timeout=5',
      '--quiet=true', '--console-log-level=error', '--summary-interval=0', '--enable-dht=false', '--bt-port-mapping=false',
      `--state-dir=${join(destination, 'state')}`, `--dir=${destination}`, '--out=download.bin',
      `--sftp-user=${metadata.username}`, `--sftp-passwd=${password}`, `--ssh-host-key-sha256=${pin}`, metadata.url], { stdio: 'ignore' })
    children.add(child)
    const timeout = setTimeout(() => child.kill('SIGTERM'), 20000)
    const [code] = await once(child, 'exit')
    clearTimeout(timeout); children.delete(child)
    return { code, destination }
  }
  const pin = metadata.hostKeySHA256.replace(/^SHA256:/, '') + '='
  const accepted = await run('accepted', pin, metadata.password)
  assert.equal(accepted.code, 0, 'Pinned SFTP download must succeed')
  const bytes = await readFile(join(accepted.destination, 'download.bin'))
  assert.equal(bytes.length, metadata.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256)
  let before = await events()
  const mismatch = await run('wrong-pin', Buffer.alloc(32, 17).toString('base64'), metadata.password)
  assert.notEqual(mismatch.code, 0)
  let after = (await events()).slice(before.length)
  assert.ok(!after.some(entry => entry.event === 'authentication'), 'Wrong host pin must stop before password authentication')
  assert.ok(!after.some(entry => entry.event === 'read'), 'Wrong host pin must not read payload')
  before = await events()
  const wrongPassword = await run('wrong-password', pin, 'generated-wrong-fixture-password')
  assert.notEqual(wrongPassword.code, 0)
  after = (await events()).slice(before.length)
  assert.ok(after.some(entry => entry.event === 'authentication' && entry.accepted === false))
  assert.ok(!after.some(entry => entry.event === 'read'), 'Wrong password must not read payload')
  console.log(JSON.stringify({ passed: true, bytes: bytes.length, sha256: metadata.sha256, hostPinBeforeAuthentication: true, wrongPasswordRejected: true }))
} finally {
  for (const child of children) child.kill('SIGTERM')
  fixture.kill('SIGTERM')
  await fixtureExit
  if (metadata?.root && metadata.root.includes('/ndm-sftp-fixture-')) await rm(metadata.root, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
}
