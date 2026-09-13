import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-waiting-queue-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { stateDirectory: root, defaultDownloadDirectory: root, aria2Path: '', ytDlpPath: '', ffmpegPath: '' }
  const make = () => new WindowsDownloadEngine(options, { onEvent() {}, onStatus() {} })
  const engine = make()
  const ids = []
  for (const name of ['a', 'b', 'c']) ids.push((await engine.request('add', { url: `https://example.test/${name}`, autoStart: false })).task.id)
  for (const task of engine.tasks) { task.status = 'waiting'; task.gid = `gid${task.id}` }
  const queue = ids.map(id => `gid${id}`)
  const changes = []
  engine.rpc.call = async (method, args) => {
    if (method === 'tellWaiting') return queue.map(gid => ({ gid, status: 'waiting' }))
    if (method === 'changePosition') {
      changes.push(args)
      const old = queue.indexOf(args[0]); queue.splice(old, 1); queue.splice(args[1], 0, args[0]); return args[1]
    }
    throw new Error(`unexpected ${method}`)
  }
  return { engine, ids, queue, changes, make, state: async () => JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) }
}

test('waiting queue follows authoritative aria2 order and moves one item atomically', async t => {
  const f = await fixture(t), [a, b, c] = f.ids
  assert.deepEqual((await f.engine.request('getWaitingQueue')).tasks.map(row => row.id), [a, b, c])
  const reply = await f.engine.request('moveQueuedTask', { taskID: c, beforeTaskID: a, expectedIDs: f.ids })
  assert.deepEqual(reply.tasks.map(row => row.id), [c, a, b])
  assert.deepEqual(f.changes, [[`gid${c}`, 0, 'POS_SET']])
  assert.deepEqual((await f.state()).tasks.sort((a,b) => a.queueRank-b.queueRank).map(row => row.id), [c,a,b])
})

test('stale queues and malformed targets do not send a move or write new ranks', async t => {
  const f = await fixture(t), [a,b,c] = f.ids
  for (const extra of [
    {taskID:c,beforeTaskID:a,expectedIDs:[b,a,c]}, {taskID:c,beforeTaskID:String(a),expectedIDs:f.ids},
    {taskID:c,beforeTaskID:c,expectedIDs:f.ids}, {taskID:99,beforeTaskID:null,expectedIDs:f.ids}
  ]) await assert.rejects(f.engine.request('moveQueuedTask', extra), /队列已变化/)
  assert.equal(f.changes.length,0)
})

test('restarting and resume-all keeps saved priority while newly queued tasks append', async t => {
  const f = await fixture(t), [a,b,c] = f.ids
  await f.engine.request('moveQueuedTask', {taskID:c,beforeTaskID:a,expectedIDs:f.ids})
  const restarted = f.make(), starts = []
  restarted.rpc.call = async (method,args) => {
    assert.equal(method,'addUri'); starts.push(args[0][0]); return `new${starts.length}`
  }
  await restarted.request('add', {url:'https://example.test/d',autoStart:false})
  await restarted.request('resumeAll')
  assert.deepEqual(starts, ['c','a','b','d'].map(name=>`https://example.test/${name}`))
})

test('RPC failures remain failures and preserve durable priority', async t => {
  const f = await fixture(t), [a,b,c] = f.ids
  const original=f.engine.rpc.call
  f.engine.rpc.call=async(method,args)=>{if(method==='changePosition')throw new Error('RPC unavailable');return original(method,args)}
  await assert.rejects(f.engine.request('moveQueuedTask',{taskID:c,beforeTaskID:a,expectedIDs:f.ids}),/RPC unavailable/)
  assert.deepEqual(f.queue,[a,b,c].map(id=>`gid${id}`))
  assert.ok((await f.state()).tasks.every(task=>task.queueRank===undefined))
})
