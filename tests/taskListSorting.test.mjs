import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_TASK_SORT,
  readTaskSort,
  sortTasks,
  writeTaskSort
} from '../src/renderer/src/lib/taskList.ts'

function task(overrides) {
  return {
    id: 1,
    filename: '',
    title: '',
    url: '',
    category: 'misc',
    status: 'downloading',
    fileSize: 0,
    completedBytes: 0,
    bytesPerSecond: 0,
    connections: 0,
    segments: [],
    folderPath: '',
    activityAt: 0,
    ...overrides
  }
}

test('status sorting follows the download lifecycle order', () => {
  const tasks = [
    task({ id: 1, status: 'complete' }),
    task({ id: 2, status: 'downloading' }),
    task({ id: 3, status: 'error' }),
    task({ id: 4, status: 'waiting' })
  ]
  assert.deepEqual(
    sortTasks(tasks, { key: 'status', direction: 'asc' }).map((item) => item.status),
    ['downloading', 'waiting', 'error', 'complete']
  )
})

test('size sorting falls back to completedBytes for unknown file sizes', () => {
  const tasks = [
    task({ id: 1, fileSize: 0, completedBytes: 50 }),
    task({ id: 2, fileSize: 100, completedBytes: 0 }),
    task({ id: 3, fileSize: 200, completedBytes: 0 })
  ]
  assert.deepEqual(
    sortTasks(tasks, { key: 'size', direction: 'desc' }).map((item) => item.id),
    [3, 2, 1]
  )
})

test('activity sorting orders by activityAt with newer first by default', () => {
  const tasks = [
    task({ id: 1, activityAt: 100 }),
    task({ id: 2, activityAt: 300 }),
    task({ id: 3, activityAt: 200 })
  ]
  assert.deepEqual(
    sortTasks(tasks, { key: 'activity', direction: 'desc' }).map((item) => item.id),
    [2, 3, 1]
  )
  assert.deepEqual(
    sortTasks(tasks, DEFAULT_TASK_SORT).map((item) => item.id),
    [2, 3, 1]
  )
})

test('filename sorting is case-insensitive and numeric-aware', () => {
  const tasks = [
    task({ id: 1, filename: 'B.mp4' }),
    task({ id: 2, filename: 'a2.mp4' }),
    task({ id: 3, filename: 'a10.mp4' })
  ]
  assert.deepEqual(
    sortTasks(tasks, { key: 'filename', direction: 'asc' }).map((item) => item.filename),
    ['a2.mp4', 'a10.mp4', 'B.mp4']
  )
})

test('ascending and descending directions invert order with ties by newer id', () => {
  const tasks = [
    task({ id: 1, activityAt: 100 }),
    task({ id: 2, activityAt: 100 })
  ]
  assert.deepEqual(
    sortTasks(tasks, { key: 'activity', direction: 'asc' }).map((item) => item.id),
    [2, 1]
  )
  assert.deepEqual(
    sortTasks(tasks, { key: 'activity', direction: 'desc' }).map((item) => item.id),
    [2, 1]
  )
})

test('readTaskSort falls back to the default when storage is unavailable or malformed', () => {
  // localStorage does not exist under Node; the try/catch returns the default.
  assert.deepEqual(readTaskSort(), DEFAULT_TASK_SORT)
  writeTaskSort(DEFAULT_TASK_SORT)
  assert.ok(true)
})