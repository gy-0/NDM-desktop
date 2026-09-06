import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  counts,
  filterTasks,
  getEngineStatus,
  getTasks,
  startClock
} from '../src/renderer/src/lib/store.ts'

function setupStore() {
  let onEvent = null
  let statusListener = null
  const snapshots = []
  const ndm = {
    request: async () => ({}),
    status: async () => 'live',
    getEngineError: async () => null,
    onEvent: (listener) => {
      onEvent = listener
      return () => {
        onEvent = null
      }
    },
    onStatus: (listener) => {
      statusListener = listener
      return () => {
        statusListener = null
      }
    },
    notifySnapshot: (...payload) => snapshots.push(payload)
  }
  globalThis.window = { ndm }
  const stop = startClock()
  return {
    push: (message) => onEvent?.(message),
    setStatus: (payload) => statusListener?.(payload),
    stop,
    snapshots
  }
}

function makeRows(...entries) {
  const now = Date.now()
  return entries.map((entry, i) => ({
    id: entry.id ?? i + 1,
    status: entry.status ?? 'downloading',
    filename: entry.filename ?? '',
    title: entry.title ?? '',
    url: entry.url ?? '',
    category: entry.category ?? 'misc',
    fileSize: entry.fileSize ?? 0,
    completedBytes: entry.completedBytes ?? 0,
    bytesPerSecond: entry.bytesPerSecond ?? 0,
    connections: entry.connections ?? 0,
    progressFraction: entry.progressFraction,
    activityAt: entry.activityAt ?? now,
    segments: entry.segments ?? []
  }))
}

test('partial-only views are never promoted to the notification baseline', () => {
  const { push, stop, snapshots } = setupStore()
  try {
    snapshots.length = 0
    push({ op: 'snapshot', partial: true, tasks: [{ id: 2, title: '新任务', status: 'downloading' }] })
    assert.equal(snapshots.at(-1)?.[1], false)

    push({ op: 'snapshot', tasks: makeRows({ id: 1, title: '首个任务' }) })
    assert.equal(snapshots.at(-1)?.[1], true)
  } finally {
    stop()
  }
})

test('full snapshots replace the store and carry normalized defaults', () => {
  const { push, stop } = setupStore()
  try {
    push({ op: 'snapshot', tasks: makeRows({ id: 1, title: '首个任务' }) })
    assert.equal(getTasks().length, 1)
    assert.equal(getTasks()[0].title, '首个任务')

    push({ op: 'snapshot', tasks: [{ id: 7 }] })
    assert.equal(getTasks().length, 1)
    assert.equal(getTasks()[0].status, 'waiting')
    assert.equal(getTasks()[0].category, 'misc')
    assert.equal(getTasks()[0].title, '未命名')
  } finally {
    stop()
  }
})

test('invalid snapshot payloads are dropped without disturbing state', () => {
  const { push, stop } = setupStore()
  try {
    push({ op: 'snapshot', tasks: makeRows({ id: 1, title: '保留' }) })
    push({ op: 'snapshot', tasks: 'not-an-array' })
    assert.equal(getTasks().length, 1)
    assert.equal(getTasks()[0].title, '保留')
  } finally {
    stop()
  }
})

test('partial snapshots patch matching rows and prepend unknown ones', () => {
  const { push, stop } = setupStore()
  try {
    push({ op: 'snapshot', tasks: makeRows({ id: 1, title: '一' }, { id: 2, title: '二' }) })
    push({ op: 'snapshot', tasks: makeRows({ id: 3, title: '三' }) })
    assert.deepEqual(getTasks().map((task) => task.id), [3])

    push({ op: 'snapshot', partial: true, tasks: [{ id: 3, status: 'paused' }] })
    assert.deepEqual(getTasks().map((task) => task.id), [3])
    assert.equal(getTasks()[0].status, 'paused')

    push({ op: 'snapshot', partial: true, tasks: [
      { id: 3, status: 'waiting' },
      { id: 9, status: 'downloading', title: '新增' }
    ] })
    assert.deepEqual(getTasks().map((task) => task.id).sort((a, b) => a - b), [3, 9])
    assert.equal(getTasks()[0].title, '新增')
  } finally {
    stop()
  }
})

test('counts bucket status filters and categories', () => {
  const { push, stop } = setupStore()
  try {
    push({ op: 'snapshot', tasks: makeRows(
      { id: 1, status: 'downloading', category: 'video' },
      { id: 2, status: 'waiting', category: 'video' },
      { id: 3, status: 'paused', category: 'audio' },
      { id: 4, status: 'complete', category: 'document' },
      { id: 5, status: 'error', category: 'misc' }
    ) })
    assert.equal(counts().all, 5)
    assert.equal(counts().active, 1)
    assert.equal(counts().queued, 1)
    assert.equal(counts().paused, 1)
    assert.equal(counts().completed, 1)
    assert.equal(counts().failed, 1)
    assert.equal(counts().video, 2)
    assert.equal(counts().audio, 1)
    assert.equal(counts().document, 1)
    assert.equal(counts().misc, 1)
    assert.equal(counts().image, 0)
  } finally {
    stop()
  }
})

test('filterTasks matches status, category, and Chinese case-insensitive search', () => {
  const { push, stop } = setupStore()
  try {
    push({ op: 'snapshot', tasks: makeRows(
      { id: 1, title: '机器学习基础', filename: 'ml-basic.pdf', category: 'document' },
      { id: 2, title: 'Video Tutorial', filename: 'tutorial.mp4', category: 'video' },
      { id: 3, title: '无匹配内容', filename: 'x.zip', category: 'compressed' }
    ) })
    assert.deepEqual(filterTasks('all', '学习').map((task) => task.id), [1])
    assert.deepEqual(filterTasks('all', 'tutorial').map((task) => task.id), [2])
    assert.deepEqual(filterTasks('all', 'VIDEO').map((task) => task.id), [2])
    assert.deepEqual(filterTasks('all', '不存在的').map((task) => task.id), [])
    // The filter applies before the search term.
    assert.deepEqual(filterTasks('document', '学习').map((task) => task.id), [1])
    assert.deepEqual(filterTasks('video', '学习').map((task) => task.id), [])
  } finally {
    stop()
  }
})

test('unchanged rows keep object identity across snapshots', () => {
  const { push, stop } = setupStore()
  try {
    push({ op: 'snapshot', tasks: makeRows({ id: 1, title: '不变' }) })
    const first = getTasks()[0]

    push({ op: 'snapshot', tasks: makeRows({ id: 1, title: '不变' }) })
    assert.equal(getTasks()[0], first)

    push({ op: 'snapshot', partial: true, tasks: [{ id: 1, title: 'changed', status: 'waiting' }] })
    assert.notEqual(getTasks()[0], first)
    assert.equal(getTasks()[0].title, 'changed')
  } finally {
    stop()
  }
})

test('engine status boots from status() and updates via onStatus', () => {
  const { stop, setStatus } = setupStore()
  try {
    assert.equal(getEngineStatus(), 'live')
    setStatus({ status: 'down', engineError: 'disconnected' })
    assert.equal(getEngineStatus(), 'down')
  } finally {
    stop()
  }
})