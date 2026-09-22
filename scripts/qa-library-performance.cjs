// Production pure task-list functions, synthetic records only. Can run under Node or Electron.
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { sortTasks, buildDisplayItems } = require(process.argv[2])
const tasks = Array.from({ length: 10000 }, (_, index) => ({
  id: index + 1, filename: `项目-${(index * 7919) % 10000}-素材.zip`, title: '',
  status: 'complete', fileSize: 1000, completedBytes: 1000, activityAt: index,
  collection: { id: `collection-${index % 1000}`, index: Math.floor(index / 1000) }
}))
const original = tasks.map(task => task.id)
const measure = operation => {
  const values = []
  for (let i = 0; i < 4; i++) { const start = performance.now(); operation(); if (i) values.push(performance.now() - start) }
  return Math.round(values.sort((a, b) => a - b)[1] * 100) / 100
}
let sorted, display
const filenameSortMs = measure(() => { sorted = sortTasks(tasks, { key: 'filename', direction: 'asc' }) })
const expanded = new Set(tasks.map(task => task.collection.id))
const collectionGroupingMs = measure(() => { display = buildDisplayItems(sorted, tasks, expanded) })
assert.deepEqual(tasks.map(task => task.id), original)
assert.equal(new Set(sorted.map(task => task.id)).size, tasks.length)
assert.equal(display.filter(item => item.kind === 'collection').length, 1000)
assert.equal(display.filter(item => item.kind === 'task').length, tasks.length)
for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i - 1].filename.localeCompare(sorted[i].filename, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }) <= 0)
console.log(JSON.stringify({ records: tasks.length, collections: 1000, filenameSortMs, collectionGroupingMs, exactMembership: true, inputUnchanged: true }))
if (process.versions.electron) require('electron').app.exit(0)
