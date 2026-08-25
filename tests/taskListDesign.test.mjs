import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const taskRow = fs.readFileSync('src/renderer/src/components/TaskRow.tsx', 'utf8')
const collectionRow = fs.readFileSync('src/renderer/src/components/CollectionRow.tsx', 'utf8')
const virtualList = fs.readFileSync('src/renderer/src/components/VirtualTaskList.tsx', 'utf8')

test('task library is a continuous data list instead of a grid of effect cards', () => {
  assert.doesNotMatch(taskRow, /CardSpotlight|rounded-\[13px\]|bg-linear-to-l/)
  assert.doesNotMatch(collectionRow, /CardContainer|CardSpotlight|card-3d|rounded-\[14px\]/)
  assert.match(virtualList, /文件名/)
  assert.match(virtualList, /大小 \/ 速度/)
  assert.match(virtualList, /进度/)
  assert.match(virtualList, /gap: 3/)
})

test('task state stays legible without decorative status dots', () => {
  assert.match(taskRow, /function StatusLabel/)
  assert.match(taskRow, /CircleAlert/)
  assert.match(taskRow, /ArrowDownToLine/)
  assert.doesNotMatch(taskRow, /size-1\.5 rounded-full/)
})

test('completed tasks stop presenting a finished operation as active progress', () => {
  assert.match(taskRow, /const showProgress = !completed/)
  assert.doesNotMatch(taskRow, /hasProgress = completed/)
  assert.match(collectionRow, /completed < count && fraction > 0/)
})

test('selection and hover use a whole-row surface without a hard leading stripe or action slab', () => {
  assert.match(taskRow, /aria-pressed=\{isHighlighted\}/)
  assert.doesNotMatch(taskRow, /inset_2px_0_0/)
  assert.doesNotMatch(taskRow, /border-l border-line bg-raised/)
})
