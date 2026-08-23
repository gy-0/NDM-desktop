import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const store = fs.readFileSync('src/renderer/src/lib/store.ts', 'utf8')

test('single-task toggles require an engine acknowledgement', () => {
  assert.match(store, /if \(!task\) throw new Error\('任务已不在列表中'\)/)
  assert.match(store, /request\('pause', \{ taskID: id \}\) as \{ ok\?: boolean \}/)
  assert.match(store, /request\('resume', \{ taskID: id \}\) as \{ ok\?: boolean \}/)
  assert.match(store, /if \(!reply\?\.ok\) throw new Error/)
})

test('selected task actions keep exact partial results visible', () => {
  assert.match(app, /const \[batchTaskAction, setBatchTaskAction\]/)
  assert.match(app, /for \(const id of ids\)[\s\S]*?await toggle\(id\)[\s\S]*?acknowledged \+= 1/)
  assert.match(app, /只\$\{verb\}了 \$\{acknowledged\}\/\$\{ids\.length\} 个任务/)
  assert.match(app, /role="toolbar"[\s\S]*?aria-label="批量任务操作"[\s\S]*?aria-busy=\{batchTaskBusy\}/)
  assert.match(app, /id="batch-task-action-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/)
  assert.match(app, /aria-describedby=\{batchTaskError \? 'batch-task-action-status'/)
  assert.match(app, /disabled=\{batchTaskBusy\}/)
})
