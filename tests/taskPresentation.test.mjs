import assert from 'node:assert/strict'
import test from 'node:test'
import { taskFailureSummary } from '../src/renderer/src/lib/taskPresentation.ts'

test('a resumed task does not retain stale failure guidance', () => {
  for (const status of ['downloading', 'paused', 'waiting', 'complete', 'incomplete']) {
    assert.equal(taskFailureSummary({ status, errorText: '磁盘空间不足', diagnostic: { summary: '旧错误' } }), undefined)
  }
})
test('specific disk and transport errors stay readable without requiring hover', () => {
  assert.equal(taskFailureSummary({ status: 'error', errorText: '磁盘空间不足，请释放空间。' }), '磁盘空间不足，请释放空间。')
  assert.equal(taskFailureSummary({ status: 'error', errorText: '连接中断\n  请稍后重试。' }), '连接中断 请稍后重试。')
})
test('engine diagnostic guidance takes precedence over its protocol token', () => {
  assert.equal(taskFailureSummary({ status: 'error', errorText: '#diag:downloadRecordChanged', diagnostic: { title: '来源已变化', summary: '请确认重新下载。' } }), '请确认重新下载。')
  assert.equal(taskFailureSummary({ status: 'error', errorText: '#diag:unexpectedWebPage', diagnostic: { title: '服务器返回了网页', summary: '   ' } }), '服务器返回了网页')
})
test('missing diagnostics do not expose protocol codes as instructions', () => {
  assert.equal(taskFailureSummary({ status: 'error', errorText: '#diag:unknownFutureReason' }), '下载未完成，请查看详情恢复。')
  assert.equal(taskFailureSummary({ status: 'error' }), '下载未完成，请查看详情恢复。')
})
