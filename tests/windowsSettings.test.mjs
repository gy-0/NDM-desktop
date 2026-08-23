import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'

test('failed download-directory validation preserves the last durable Windows setting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-windows-settings-'))
  const stateDirectory = join(root, 'state')
  const validDirectory = join(root, 'downloads')
  await mkdir(stateDirectory)
  await mkdir(validDirectory)

  const engine = new WindowsDownloadEngine({
    stateDirectory,
    defaultDownloadDirectory: validDirectory,
    aria2Path: '',
    ytDlpPath: '',
    ffmpegPath: ''
  }, {
    onStatus() {},
    onEvent() {}
  })

  try {
    await engine.request('updateSettings', { maxConnections: 4 })
    const blockingFile = join(root, 'not-a-directory')
    const invalidDirectory = join(blockingFile, 'downloads')
    await writeFile(blockingFile, 'block')

    await assert.rejects(
      engine.request('updateSettings', { downloadDirectory: invalidDirectory }),
      /not a directory|ENOTDIR/i
    )

    const current = await engine.request('getSettings')
    assert.equal(current.settings.downloadDirectory, validDirectory)
    const persisted = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'))
    assert.equal(persisted.settings.downloadDirectory, validDirectory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows proxy settings reject invalid ports without poisoning durable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-windows-proxy-settings-'))
  const stateDirectory = join(root, 'state')
  const downloadDirectory = join(root, 'downloads')
  await mkdir(stateDirectory)
  await mkdir(downloadDirectory)
  const engine = new WindowsDownloadEngine({
    stateDirectory,
    defaultDownloadDirectory: downloadDirectory,
    aria2Path: '',
    ytDlpPath: '',
    ffmpegPath: ''
  }, {
    onStatus() {},
    onEvent() {}
  })

  try {
    await engine.request('updateSettings', {
      httpProxyHost: ' ::1 ',
      httpProxyPort: 7890,
      httpProxyEnabled: true
    })
    await assert.rejects(
      engine.request('updateSettings', { httpProxyHost: 'poisoned', httpProxyPort: 65_536 }),
      /1–65535/
    )
    const current = await engine.request('getSettings')
    assert.equal(current.settings.httpProxyHost, '::1')
    assert.equal(current.settings.httpProxyPort, 7890)
    assert.equal(current.settings.httpProxyEnabled, true)
    const persisted = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'))
    assert.equal(persisted.settings.httpProxyHost, '::1')
    assert.equal(persisted.settings.httpProxyPort, 7890)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows batch deletion reports the exact acknowledged count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-windows-batch-delete-'))
  const stateDirectory = join(root, 'state')
  const downloadDirectory = join(root, 'downloads')
  await mkdir(stateDirectory)
  await mkdir(downloadDirectory)
  const engine = new WindowsDownloadEngine({
    stateDirectory,
    defaultDownloadDirectory: downloadDirectory,
    aria2Path: '',
    ytDlpPath: '',
    ffmpegPath: ''
  }, {
    onStatus() {},
    onEvent() {}
  })

  try {
    const first = await engine.request('add', {
      url: 'https://example.com/a.bin',
      filename: 'a.bin',
      autoStart: false
    })
    const second = await engine.request('add', {
      url: 'https://example.com/b.bin',
      filename: 'b.bin',
      autoStart: false
    })
    const reply = await engine.request('removeMany', {
      taskIDs: [first.task.id, second.task.id],
      deleteFile: false
    })
    assert.deepEqual(reply, { ok: true, removed: 2 })
    const remaining = await engine.request('list')
    assert.deepEqual(remaining.tasks, [])
    const persisted = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'))
    assert.deepEqual(persisted.tasks, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
