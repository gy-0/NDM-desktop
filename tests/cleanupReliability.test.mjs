import assert from 'node:assert/strict'
import test from 'node:test'
import { historyTaskIDs, historyClearError } from '../src/renderer/src/lib/downloadHistory.ts'

const tasks = ['complete', 'error', 'paused', 'incomplete', 'downloading', 'waiting'].map((status, i) => ({ id: i + 1, status }))
test('history removal protects resumable and active tasks for every selection', () => {
  assert.deepEqual(historyTaskIDs(tasks, { completed: true, failed: false }), [1])
  assert.deepEqual(historyTaskIDs(tasks, { completed: true, failed: true }), [1, 2])
  assert.deepEqual(historyTaskIDs(tasks, { completed: false, failed: true }), [2])
  assert.deepEqual(historyTaskIDs(tasks, { completed: false, failed: false }), [])
  assert.deepEqual(historyTaskIDs(tasks.slice(2), { completed: true, failed: true }), [])
})
test('history failures distinguish acknowledged partial removal from a failed request', () => {
  assert.equal(historyClearError(new Error('只删除了 2/7 个任务。请检查剩余任务后重试。')), '已清除 2 条记录，其余 5 条未能清除。请重试。')
  assert.equal(historyClearError(new Error('Engine disconnected')), '未能清除下载记录。请重试。')
})
