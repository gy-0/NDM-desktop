import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rename, unlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OriginalControl } from '../src/main/original/control.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-control-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function take(root) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const command = JSON.parse(await readFile(join(root, 'command.json'), 'utf8'))
      await unlink(join(root, 'command.json'))
      return command
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(5)
  }
  throw new Error('No command published')
}
async function reply(root, data) {
  await writeFile(join(root, 'reply.tmp'), JSON.stringify(data))
  await rename(join(root, 'reply.tmp'), join(root, 'command-result.json'))
}
test('original control serializes commands and ignores stale acknowledgements', async t => {
  const root = await fixture(t), client = new OriginalControl(root, 2000)
  await reply(root, { nonce: 'stale', ok: true })
  const first = client.request('pause', '12'), second = client.request('resume', '12')
  const command = await take(root)
  assert.equal(command.operation, 'pause')
  await delay(40)
  await assert.rejects(stat(join(root, 'command.json')), { code: 'ENOENT' })
  await reply(root, { nonce: command.nonce, ok: true, settled: true })
  assert.equal((await first).settled, true)
  const next = await take(root)
  assert.equal(next.operation, 'resume')
  assert.notEqual(next.nonce, command.nonce)
  await reply(root, { nonce: next.nonce, ok: false, error: 'interaction-required' })
  assert.equal((await second).ok, false)
  await assert.rejects(stat(join(root, 'desktop-control.lock')), { code: 'ENOENT' })
})
test('uncertain outcome retains exclusion across clients and does not replay', async t => {
  const root = await fixture(t), client = new OriginalControl(root, 50)
  const pending = assert.rejects(client.request('pause', '1'), /outcome unknown/)
  const sent = await take(root)
  await pending
  const lock = JSON.parse(await readFile(join(root, 'desktop-control.lock'), 'utf8'))
  assert.equal(lock.nonce, sent.nonce)
  await assert.rejects(new OriginalControl(root).request('resume', '1'), { code: 'EEXIST' })
  await assert.rejects(stat(join(root, 'command.json')), { code: 'ENOENT' })
})
test('existing command is never overwritten and invalid input is not published', async t => {
  const root = await fixture(t), client = new OriginalControl(root)
  await writeFile(join(root, 'command.json'), 'existing')
  await assert.rejects(client.request('pause', '2'), { code: 'EEXIST' })
  assert.equal(await readFile(join(root, 'command.json'), 'utf8'), 'existing')
  await assert.rejects(stat(join(root, 'desktop-control.lock')), { code: 'ENOENT' })
  await assert.rejects(client.request('pause', '9007199254740992'), /Invalid/)
  await assert.rejects(client.request('submit-auth', '2', { username: 'a', password: 'x'.repeat(4096) }), /too large/)
})
