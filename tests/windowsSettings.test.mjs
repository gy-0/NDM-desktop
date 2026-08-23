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
