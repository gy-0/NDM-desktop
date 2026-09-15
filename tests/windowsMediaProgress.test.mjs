import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'

async function withEngine(operation) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-media-progress-'))
  const engine = new WindowsDownloadEngine({ stateDirectory: root, defaultDownloadDirectory: root,
    aria2Path: join(root, 'unused-aria2'), ytDlpPath: join(root, 'unused-ytdlp'), ffmpegPath: join(root, 'unused-ffmpeg') },
  { onEvent() {}, onStatus() {} })
  try { await engine.loadState(); await operation(engine) }
  finally { await engine.persist(); await engine.saveChain; await rm(root, { recursive: true, force: true }) }
}

test('HLS estimates can shrink while pending audio remains reserved', async () => {
  await withEngine(async engine => {
    const task = { id: 1, mediaFormatID: '616+140', mediaComponentBytes: [225_000_000, 5_000_000],
      fileSize: 230_000_000, completedBytes: 0, status: 'downloading' }
    const run = { stopping: false }
    engine.mediaRuns.set(1, run)
    const report = (downloaded, total, id, status, speed = 1000) =>
      engine.applyMediaOutput(task, run, `NDM_PROGRESS|${downloaded}|NA|${total}|${speed}|${id}|${status}`)
    report(2_000_000, 220_000_000, '616', 'downloading')
    report(20_000_000, 42_000_000, '616', 'downloading')
    assert.equal(task.fileSize, 47_000_000)
    assert.equal(task.completedBytes, 20_000_000)
    report(40_000_000, 42_000_000, '616', 'finished')
    assert.equal(task.fileSize, 45_000_000)
    assert.equal(task.completedBytes, 40_000_000)
    assert.equal(task.bytesPerSecond, 0)
    assert.equal(task.status, 'downloading')
    report(2_000_000, 4_000_000, '140', 'downloading', 300)
    assert.equal(task.fileSize, 44_000_000)
    assert.equal(task.completedBytes, 42_000_000)
    assert.equal(task.bytesPerSecond, 300)
    report(4_000_000, 4_000_000, '140', 'finished')
    assert.equal(task.fileSize, 44_000_000)
    assert.equal(task.completedBytes, 44_000_000)
    // The process/merge still has to finish before the ledger is complete.
    assert.equal(task.status, 'downloading')
  })
})

test('older media tasks replace combined estimate when both actual streams are known', async () => {
  await withEngine(async engine => {
    const task = { id: 2, mediaFormatID: '616+140', fileSize: 230_000_000, completedBytes: 0 }
    const run = { stopping: false }
    engine.mediaRuns.set(2, run)
    engine.applyMediaOutput(task, run, 'NDM_PROGRESS|40000000|40000000|NA|0|616|finished')
    assert.equal(task.fileSize, 230_000_000)
    engine.applyMediaOutput(task, run, 'NDM_PROGRESS|2000000|4000000|NA|200|140|downloading')
    assert.equal(task.fileSize, 44_000_000)
    assert.equal(task.completedBytes, 42_000_000)
    assert.equal(task.bytesPerSecond, 200)
  })
})
