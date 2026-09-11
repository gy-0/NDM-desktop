import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existingDragFiles } from '../src/main/fileDrag.ts'
import { completedDragPaths } from '../src/renderer/src/lib/fileDrag.ts'

test('native drag validates all files and preserves their contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'ndm-drag-test-'))
  try {
    const file = join(root, '下载 验证.txt')
    writeFileSync(file, 'original')
    assert.deepEqual(existingDragFiles([file, file]), [file])
    for (const input of [[root], [file, join(root, 'missing')], ['relative.txt'], ['https://example.com/a'], [null], 'file']) {
      assert.deepEqual(existingDragFiles(input), [])
    }
    assert.equal(readFileSync(file, 'utf8'), 'original')
  } finally { rmSync(root, { recursive: true }) }
})

test('drag uses the completed selection, or the unselected source row alone', () => {
  const tasks = [{id:1,status:'complete',folderPath:'/tmp/',filename:'A.txt'}, {id:2,status:'complete',folderPath:'/tmp',filename:'B.txt'}, {id:3,status:'downloading',folderPath:'/tmp',filename:'C.txt'}]
  assert.deepEqual(completedDragPaths(tasks[0], tasks, new Set([1,2,3])), ['/tmp/A.txt', '/tmp/B.txt'])
  assert.deepEqual(completedDragPaths(tasks[0], tasks, new Set([2])), ['/tmp/A.txt'])
  assert.deepEqual(completedDragPaths(tasks[2], tasks, new Set([1,2,3])), [])
})
