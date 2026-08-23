import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const store = fs.readFileSync('src/renderer/src/lib/store.ts', 'utf8')

test('library-wide controls require an engine acknowledgement', () => {
  assert.match(store, /request\('pauseAll'\)[\s\S]*?if \(!reply\?\.ok\) throw new Error\('未能暂停全部任务'\)/)
  assert.match(store, /request\('resumeAll'\)[\s\S]*?if \(!reply\?\.ok\) throw new Error\('未能继续已暂停任务'\)/)
  assert.match(store, /request\('restart', \{ taskID: id \}\)[\s\S]*?if \(!reply\?\.ok\)/)
  assert.match(store, /request\('restartMany', \{ taskIDs: ids \}\)[\s\S]*?if \(!reply\?\.ok\)/)
  assert.match(store, /Math\.min\(ids\.length, Math\.max\(0, Number\(reply\.count \?\? 0\)\)\)/)
})

test('library-wide controls expose busy, partial and disconnected results', () => {
  assert.match(app, /const \[libraryAction, setLibraryAction\]/)
  assert.match(app, /catch \{[\s\S]*?未能暂停全部任务。请检查下载引擎后重试。/)
  assert.match(app, /只重试了 \$\{count\}\/\$\{failedIds\.length\} 个失败任务/)
  assert.match(app, /id="library-action-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/)
  assert.match(app, /aria-describedby=\{libraryActionError \? 'library-action-status'/)
  assert.match(app, /disabled=\{libraryActionBusy\}/)
  assert.match(app, /aria-label="关闭批量操作提示"/)
})
