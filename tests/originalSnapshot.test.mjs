import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapOriginalSnapshot } from '../src/main/original/snapshot.ts'
const now = 1700000000000
const record = { id: 9, status: '25%', filename: 'file.bin', url: 'https://example.test/file', filesize: 100, folderpath: '/isolated/downloads/', category: 'Misc' }
function snapshot(records = [record], tasks = []) { return { pid: 42, time: now / 1000, records, tasks } }
const live = { id: 9, key: '9', working: true, waiting: false, authenticating: false,
  engineProgress: { completedBytes: 25, bytesPerSecond: 10, segments: [{ start: 0, completed: 10 }, { start: 50, completed: 15 }] } }
test('original snapshot uses durable IDs and accurate live bytes and segment bounds', () => {
  const result = mapOriginalSnapshot(snapshot([record], [live]), 42, now).tasks[0]
  assert.equal(result.id, 9)
  assert.equal(result.status, 'downloading')
  assert.equal(result.completedBytes, 25)
  assert.equal(result.bytesPerSecond, 10)
  assert.deepEqual(result.segments.map(s => [s.start, s.end, s.fraction]), [[0, 49, .2], [50, 99, .3]])
})
test('persisted percent is not download activity or a fabricated byte count', () => {
  const result = mapOriginalSnapshot(snapshot([{ ...record, folderpath: '' }]), 42, now).tasks[0]
  assert.equal(result.folderPath, '')
  assert.equal(result.status, 'incomplete')
  assert.equal(result.progressFraction, .25)
  assert.equal(result.completedBytes, 0)
  assert.equal(result.bytesPerSecond, 0)
  const paused = mapOriginalSnapshot(snapshot([{ ...record, status: 'Paused ( 25% )' }]), 42, now).tasks[0]
  assert.equal(paused.status, 'paused')
  assert.equal(paused.progressFraction, .25)
})
test('authentication suppresses stale speed; durable completion wins over old progress', () => {
  const auth = mapOriginalSnapshot(snapshot([record], [{ ...live, authenticating: true }]), 42, now).tasks[0]
  assert.equal(auth.status, 'waiting')
  assert.equal(auth.bytesPerSecond, 0)
  assert.ok(auth.diagnostic)
  const done = mapOriginalSnapshot(snapshot([{ ...record, status: 'Complete' }], [live]), 42, now).tasks[0]
  assert.equal(done.status, 'complete')
  assert.equal(done.completedBytes, 100)
  assert.equal(done.bytesPerSecond, 0)
})
test('stale, foreign, ambiguous and inconsistent snapshots are rejected', () => {
  assert.throws(() => mapOriginalSnapshot(snapshot(), 41, now), /process mismatch/)
  assert.throws(() => mapOriginalSnapshot(snapshot(), 42, now + 6000), /expired/)
  assert.throws(() => mapOriginalSnapshot(snapshot([record, record]), 42, now), /Duplicate/)
  assert.throws(() => mapOriginalSnapshot(snapshot([record], [{ ...live, key: '10' }]), 42, now), /identity/)
  assert.throws(() => mapOriginalSnapshot(snapshot([record], [{ ...live, engineProgress: { ...live.engineProgress, completedBytes: 24 } }]), 42, now), /mismatch/)
})
