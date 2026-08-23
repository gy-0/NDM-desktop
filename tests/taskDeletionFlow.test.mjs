import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('shell deletion entry points open one acknowledged confirmation flow', () => {
  const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
  assert.match(app, /const requestDelete = useCallback/)
  assert.match(app, /await removeMany\(pendingDelete.ids, deleteFile\)/)
  assert.match(app, /catch \(error\)[\s\S]*?setPendingDeleteError/)
  assert.match(app, /error\.message\.startsWith\('只删除了 '\)/)
  assert.match(app, /requestDelete\(Array\.from\(selectedIds\), deleteFile\)/)
  assert.match(app, /onDelete=\{\(t, deleteFile\) => \{[\s\S]*?requestDelete\(\[t.id\], deleteFile\)/)
  assert.doesNotMatch(app, /void removeMany\(Array\.from\(selectedIds\)/)
})

test('batch deletion keeps partial engine results honest', () => {
  const store = fs.readFileSync('src/renderer/src/lib/store.ts', 'utf8')
  const windows = fs.readFileSync('src/main/windows/windowsEngine.ts', 'utf8')
  assert.match(store, /if \(!reply\?\.ok\) throw new Error\('未能删除所选任务/)
  assert.match(store, /if \(removedCount !== ids.length\)/)
  assert.match(store, /只删除了 \$\{removedCount\}\/\$\{ids.length\} 个任务/)
  assert.match(windows, /return \{ ok: true, removed: ids.length \}/)
})

test('delete dialog is modal, reversible and exposes retryable errors', () => {
  const dialog = fs.readFileSync('src/renderer/src/components/DeleteTasksDialog.tsx', 'utf8')
  assert.match(dialog, /role="dialog"[\s\S]*?aria-modal="true"/)
  assert.match(dialog, /aria-busy=\{busy\}/)
  assert.match(dialog, /id="delete-tasks-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/)
  assert.match(dialog, /aria-describedby=\{error \? 'delete-tasks-description delete-tasks-status'/)
  assert.match(dialog, /仅从列表移除/)
  assert.match(dialog, /同时移到\$\{TRASH_NAME\}/)
  assert.match(dialog, /if \(event.key !== 'Escape' \|\| busy\) return/)
})
