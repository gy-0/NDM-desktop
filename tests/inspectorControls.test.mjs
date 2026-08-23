import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('per-task bandwidth waits for an acknowledged save and exposes failures', () => {
  const inspector = fs.readFileSync('src/renderer/src/components/Inspector.tsx', 'utf8')
  const store = fs.readFileSync('src/renderer/src/lib/store.ts', 'utf8')
  const handler = inspector.match(/const handleTaskBandwidth[\s\S]*?\n  \}/)
  assert.ok(handler, 'task bandwidth handler is present')
  assert.match(handler[0], /await setTaskBandwidth\(task.id, bandwidthLimit\)/)
  assert.match(handler[0], /catch \{[\s\S]*?未能保存此任务的限速/)
  assert.match(handler[0], /finally \{[\s\S]*?setSavingTaskBandwidth\(false\)/)
  assert.match(inspector, /aria-label="此任务限速"[\s\S]*?aria-busy=\{savingTaskBandwidth\}/)
  assert.match(inspector, /aria-pressed=\{active\}/)
  assert.match(inspector, /id="task-bandwidth-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/)
  assert.match(store, /setTaskBandwidth[\s\S]*?if \(!reply\?\.ok\) throw new Error\('任务限速未保存'\)/)
})

test('per-task connection changes wait for an acknowledged save and expose failures', () => {
  const inspector = fs.readFileSync('src/renderer/src/components/Inspector.tsx', 'utf8')
  const store = fs.readFileSync('src/renderer/src/lib/store.ts', 'utf8')
  const handler = inspector.match(/const handleTaskConnections[\s\S]*?\n  \}/)
  assert.ok(handler, 'task connections handler is present')
  assert.match(handler[0], /await setTaskConnections\(task.id, connections\)/)
  assert.match(handler[0], /catch \{[\s\S]*?未能保存此任务的连接数/)
  assert.match(handler[0], /finally \{[\s\S]*?setSavingTaskConnections\(false\)/)
  assert.match(inspector, /aria-label="任务连接数"[\s\S]*?aria-busy=\{savingTaskConnections\}/)
  assert.match(inspector, /id="task-connections-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/)
  assert.match(store, /setTaskConnections[\s\S]*?if \(!reply\?\.ok\) throw new Error\('任务连接数未保存'\)/)
})
