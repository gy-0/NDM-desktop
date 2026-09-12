import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finishTaskSchedule } from '../src/renderer/src/lib/store.ts'

test('cancelling an appointment parks the task before clearing it, without starting it', async () => {
  const commands = []
  globalThis.window = { ndm: { request: async (op, args) => { commands.push({ op, ...args }); return { ok: true } } } }
  await finishTaskSchedule(42, 'cancel')
  assert.deepEqual(commands, [{ op: 'pause', taskID: 42 }, { op: 'schedule', taskID: 42, startAt: null }])
})

test('starting early clears the appointment while paused, then resumes the same task', async () => {
  const commands = []
  globalThis.window = { ndm: { request: async (op, args) => { commands.push({ op, ...args }); return { ok: true } } } }
  await finishTaskSchedule(42, 'start')
  assert.deepEqual(commands, [{ op: 'pause', taskID: 42 }, { op: 'schedule', taskID: 42, startAt: null }, { op: 'resume', taskID: 42 }])
})

test('failed acknowledgements and thrown transport errors stop at the failed stage', async () => {
  for (const rejected of ['pause', 'schedule', 'resume']) {
    for (const throws of [false, true]) {
      const commands = []
      globalThis.window = { ndm: { request: async (op) => {
        commands.push(op)
        if (op === rejected && throws) throw new Error('transport rejection')
        return { ok: op !== rejected }
      } } }
      const message = { pause: /未能暂停预约任务/, schedule: /任务已暂停，未能确认预约已取消/, resume: /预约已取消，未能确认开始下载/ }[rejected]
      await assert.rejects(finishTaskSchedule(42, 'start'), message)
      assert.deepEqual(commands, ['pause', 'schedule', 'resume'].slice(0, ['pause', 'schedule', 'resume'].indexOf(rejected) + 1))
    }
  }
})
