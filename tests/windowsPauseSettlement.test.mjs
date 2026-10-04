import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-pause-settle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const engine = new WindowsDownloadEngine({ stateDirectory: root, defaultDownloadDirectory: root, aria2Path: '', ytDlpPath: '', ffmpegPath: '' }, { onEvent() {}, onStatus() {} })
  engine.rpc.call = async () => 'fixture-gid'
  const { task } = await engine.request('add', { url: 'https://example.test/file.bin', filename: 'file.bin' })
  return { engine, id: task.id }
}

test('pause waits for authoritative settlement and uses the final byte count', async t => {
  const { engine, id } = await fixture(t)
  let acknowledge, release
  const queried = new Promise(resolve => { acknowledge = resolve })
  const settled = new Promise(resolve => { release = resolve })
  let queries = 0
  engine.rpc.call = async (method, args, signal) => {
    assert.ok(signal instanceof AbortSignal)
    if (method === 'forcePause') return args[0]
    assert.equal(method, 'tellStatus')
    queries++
    if (queries === 1) return { gid: args[0], status: 'active', completedLength: '100' }
    acknowledge()
    return settled
  }
  const pausing = engine.request('pause', { taskID: id })
  await queried
  assert.equal((await engine.request('list')).tasks[0].status, 'downloading')
  release({ gid: 'fixture-gid', status: 'paused', totalLength: '1024', completedLength: '512', downloadSpeed: '0' })
  await pausing
  const state = (await engine.request('list')).tasks[0]
  assert.equal(state.status, 'paused'); assert.equal(state.completedBytes, 512)
})

for (const terminal of ['complete', 'error']) {
  test(`completion or failure racing pause remains ${terminal}`, async t => {
    const { engine, id } = await fixture(t)
    engine.rpc.call = async method => method === 'forcePause' ? 'fixture-gid' : { gid: 'fixture-gid', status: terminal, totalLength: '1024', completedLength: terminal === 'complete' ? '1024' : '512', errorCode: '8' }
    await engine.request('pause', {taskID: id})
    assert.equal((await engine.request('list')).tasks[0].status, terminal)
  })
}

test('failed confirmation does not falsely announce a paused download', async t => {
  const { engine, id } = await fixture(t)
  engine.rpc.call = async method => { if (method === 'forcePause') return 'fixture-gid'; throw new Error('RPC unavailable') }
  await assert.rejects(engine.request('pause', {taskID: id}), /RPC unavailable/)
  assert.equal((await engine.request('list')).tasks[0].status, 'downloading')
})
