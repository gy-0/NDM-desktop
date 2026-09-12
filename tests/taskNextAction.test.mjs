import assert from 'node:assert/strict'
import test from 'node:test'
import { taskNextAction } from '../src/renderer/src/lib/taskNextAction.ts'

const diagnostic = primaryAction => ({ primaryAction, title: '下载未完成', message: '', summary: '' })

test('recovery guidance opens details with or without a source page', () => {
  for (const primaryAction of ['renew', 'openPage']) {
    for (const pageURL of [undefined, 'https://example.test/download']) {
      const action = taskNextAction({ status: 'error', diagnostic: diagnostic(primaryAction), pageURL })
      assert.equal(action.kind, 'inspect')
      assert.equal(action.label, primaryAction === 'renew' ? '更新链接…' : '来源页面…')
      assert.equal(action.disabled, false)
    }
  }
  for (const reason of [undefined, diagnostic('none'), diagnostic('retry')]) {
    const action = taskNextAction({ status: 'error', diagnostic: reason })
    assert.equal(action.kind, 'restart')
    assert.equal(action.ariaLabel, '重试下载')
    assert.equal(action.busyLabel, '正在重试')
  }
})

test('choosing a destination takes precedence over ordinary task actions', () => {
  for (const status of ['downloading', 'waiting', 'paused', 'incomplete', 'error', 'complete']) {
    const action = taskNextAction({ status, awaitingDestination: true, diagnostic: diagnostic('renew') })
    assert.equal(action.kind, 'toggle')
    assert.equal(action.label, '选目录')
    assert.equal(action.disabled, false)
  }
})

test('saving a live recording cannot issue a second stop action', () => {
  const recording = { status: 'downloading', isLiveRecording: true, phase: 'transferring' }
  assert.equal(taskNextAction(recording).label, '停止并保存')
  assert.equal(taskNextAction(recording).disabled, false)
  const saving = taskNextAction({ ...recording, phase: 'merging' })
  assert.equal(saving.disabled, true)
  assert.equal(saving.label, '正在保存')
  assert.equal(saving.busyLabel, '正在保存')
  // Completed recordings keep their normal file action even if phase lingers.
  const completed = taskNextAction({ ...recording, status: 'complete', phase: 'merging', diagnostic: diagnostic('renew') })
  assert.equal(completed.kind, 'open')
  assert.equal(completed.disabled, false)
})

test('only active tasks pause; suspended tasks resume without stale recovery guidance', () => {
  for (const status of ['downloading', 'waiting']) {
    const action = taskNextAction({ status, diagnostic: diagnostic('renew') })
    assert.equal(action.kind, 'toggle')
    assert.equal(action.label, '暂停')
    assert.equal(action.busyLabel, '正在暂停')
  }
  for (const status of ['paused', 'incomplete']) {
    const action = taskNextAction({ status, isLiveRecording: true, phase: 'merging', diagnostic: diagnostic('openPage') })
    assert.equal(action.kind, 'toggle')
    assert.equal(action.label, '继续')
    assert.equal(action.busyLabel, '正在继续')
    assert.equal(action.disabled, false)
  }
})
