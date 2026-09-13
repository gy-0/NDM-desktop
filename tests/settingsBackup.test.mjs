import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildSettingsBackup, parseSettingsBackup, selectBackupSettings,
  SETTINGS_BACKUP_FORMAT, SETTINGS_BACKUP_VERSION, SETTINGS_BACKUP_MAX_BYTES
} from '../src/shared/settingsBackup.ts'
import { SettingsBackupService } from '../src/main/settingsBackup.ts'

const original = () => ({
  downloadDirectory: '/Downloads', maxConnections: 8, bandwidthLimitBytesPerSecond: 0,
  askBrowserDownloadDestination: true, useCategoryFolders: false, downloadAllAtOnce: false,
  smartConnections: false, installerSourceDisposition: 'ask', bridgePort: 5050,
  httpProxyHost: 'localhost', httpProxyPort: 8080, httpProxyEnabled: true,
  httpProxyPassword: 'keep-local-proxy-secret', cookie: 'keep-local-cookie',
  credentials: { username: 'keep-local-user', password: 'keep-local-password' }, futureSetting: 'keep-future'
})
const encode = settings => JSON.stringify(buildSettingsBackup(settings, '2026.9.14', '2026-09-14T10:00:00.000Z'))

function fixture(overrides = {}) {
  let state = original()
  let content = encode({ maxConnections: 16, useCategoryFolders: true })
  let time = Date.parse('2026-09-14T10:00:00Z')
  const writes = [], updates = []
  const dependencies = {
    appVersion: '2026.9.14', platform: 'darwin', now: () => time,
    getSettings: async () => structuredClone(state),
    updateSettings: async patch => { updates.push(structuredClone(patch)); Object.assign(state, patch); return structuredClone(state) },
    chooseExportPath: async () => '/tmp/backup.json', chooseImportPath: async () => '/tmp/backup.json',
    readTextFile: async (_path, cap) => { assert.equal(cap, SETTINGS_BACKUP_MAX_BYTES); return content },
    writeTextFile: async (path, text) => { writes.push({ path, text }) },
    ...overrides
  }
  const service = new SettingsBackupService(dependencies)
  return {
    service, dependencies, updates, writes,
    get state() { return state },
    set state(value) { state = value },
    set content(value) { content = value },
    set time(value) { time = value }
  }
}

test('versioned NDM backups round-trip only allowed settings and strip secrets and proxy configuration', () => {
  const input = original()
  const backup = buildSettingsBackup(input, '2026.9.14')
  assert.equal(backup.format, SETTINGS_BACKUP_FORMAT)
  assert.equal(backup.version, SETTINGS_BACKUP_VERSION)
  assert.deepEqual(parseSettingsBackup(JSON.stringify(backup)).backup.settings, {
    downloadDirectory: '/Downloads', maxConnections: 8, bandwidthLimitBytesPerSecond: 0,
    askBrowserDownloadDestination: true, useCategoryFolders: false, downloadAllAtOnce: false,
    smartConnections: false, installerSourceDisposition: 'ask'
  })
  assert.ok(!JSON.stringify(backup).includes('keep-local'))
  assert.ok(!Object.hasOwn(backup.settings, 'bridgePort'))
  assert.ok(!Object.hasOwn(backup.settings, 'httpProxyHost'))
  assert.equal(input.credentials.password, 'keep-local-password')
})

test('import ignores unknown fields without adding defaults or reflecting their secret values', () => {
  const document = buildSettingsBackup({ maxConnections: 4 }, '1')
  document.settings.password = 'private-import-password'
  document.settings.cookie = 'private-import-cookie'
  document.settings.futureSetting = { nested: 'private-import-value' }
  const parsed = parseSettingsBackup(JSON.stringify(document))
  assert.deepEqual(parsed.backup.settings, { maxConnections: 4 })
  assert.equal(parsed.ignoredCount, 3)
  assert.ok(!JSON.stringify(parsed).includes('private-import'))
})

test('invalid versions, envelopes and invalid known field values are rejected', () => {
  const valid = buildSettingsBackup({ maxConnections: 4 }, '1')
  for (const bad of [
    'null', '[]', '{}', '{broken',
    JSON.stringify({ ...valid, format: 'rayburst-settings' }),
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, appVersion: {} }),
    JSON.stringify({ ...valid, exportedAt: 'yesterday' }),
    JSON.stringify({ ...valid, settings: [] }),
    ...[0, 33, 2.5, '8', null, {}].map(maxConnections => JSON.stringify({ ...valid, settings: { maxConnections } })),
    JSON.stringify({ ...valid, settings: { bandwidthLimitBytesPerSecond: -1 } }),
    JSON.stringify({ ...valid, settings: { smartConnections: 'true' } }),
    JSON.stringify({ ...valid, settings: { installerSourceDisposition: 'delete-permanently' } }),
    JSON.stringify({ ...valid, settings: { downloadDirectory: '../relative' } }),
    JSON.stringify({ ...valid, settings: { downloadDirectory: '/Downloads\u0000suffix' } })
  ]) assert.throws(() => parseSettingsBackup(bad), undefined, bad.slice(0, 150))
})

test('prototype-pollution payloads are rejected even inside ignored fields', () => {
  const valid = encode({ maxConnections: 4 })
  for (const property of ['__proto__', 'constructor', 'prototype']) {
    const bad = valid.replace('"settings":{', `"settings":{"unknown":{"${property}":{"polluted":true}},`)
    assert.throws(() => parseSettingsBackup(bad), /不允许的属性/)
  }
  assert.equal({}.polluted, undefined)
  assert.throws(() => selectBackupSettings(Object.create({ maxConnections: 16 })), /有效/)
})

test('backup size cap measures UTF-8 bytes and bounded structures reject excessive nesting', () => {
  const valid = buildSettingsBackup({ maxConnections: 4 }, '1')
  assert.throws(() => parseSettingsBackup(' '.repeat(SETTINGS_BACKUP_MAX_BYTES + 1)), /256 KB/)
  const wide = JSON.stringify({ ...valid, extra: '文'.repeat(SETTINGS_BACKUP_MAX_BYTES / 2) })
  assert.ok(wide.length < SETTINGS_BACKUP_MAX_BYTES)
  assert.throws(() => parseSettingsBackup(wide), /256 KB/)
  const nested = JSON.stringify(valid).replace('"settings":{', `"settings":{"nested":${'['.repeat(15)}'deep'${']'.repeat(15)},`).replace("'deep'", '"deep"')
  assert.throws(() => parseSettingsBackup(nested), /复杂/)
})

test('preview only reads, then confirmation applies exactly the reviewed patch while preserving omitted values and secrets', async () => {
  const f = fixture()
  const preview = await f.service.request('settingsBackupPreview')
  assert.equal(preview.ok, true)
  assert.deepEqual(preview.preview.changes.map(change => [change.key, change.before, change.after]), [
    ['maxConnections', 8, 16], ['useCategoryFolders', false, true]
  ])
  assert.deepEqual(f.updates, [])
  assert.deepEqual(f.state, original())
  // The renderer cannot change what the main process reviewed.
  preview.preview.changes[0].after = 32
  const applied = await f.service.request('settingsBackupApply', { token: preview.preview.token, settings: { httpProxyPassword: 'attacker' } })
  assert.deepEqual(applied, { ok: true, applied: true, changedCount: 2 })
  assert.deepEqual(f.updates, [{ maxConnections: 16, useCategoryFolders: true }])
  assert.equal(f.state.httpProxyPassword, original().httpProxyPassword)
  assert.deepEqual(f.state.credentials, original().credentials)
  assert.equal(f.state.cookie, original().cookie)
  assert.equal(f.state.downloadDirectory, original().downloadDirectory)
  assert.equal(f.state.futureSetting, original().futureSetting)
  const replay = await f.service.request('settingsBackupApply', { token: preview.preview.token })
  assert.equal(replay.ok, false)
  assert.equal(f.updates.length, 1)
})

test('preview detects stale confirmations, expiry and file-dialog cancellation without applying anything', async () => {
  const f = fixture()
  let preview = await f.service.request('settingsBackupPreview')
  f.state.maxConnections = 6
  const stale = await f.service.request('settingsBackupApply', { token: preview.preview.token })
  assert.equal(stale.ok, false)
  assert.match(stale.error, /已被修改/)
  preview = await f.service.request('settingsBackupPreview')
  f.time = preview.preview.expiresAt
  const expired = await f.service.request('settingsBackupApply', { token: preview.preview.token })
  assert.match(expired.error, /已失效/)
  f.dependencies.chooseImportPath = async () => null
  assert.deepEqual(await f.service.request('settingsBackupPreview'), { ok: true, cancelled: true })
  assert.deepEqual(f.updates, [])
})

test('cross-platform paths and unsupported optional fields are omitted and Windows connection limits are previewed', async () => {
  const mac = fixture()
  mac.content = encode({ downloadDirectory: 'C:\\Downloads', maxConnections: 16 })
  const macPreview = (await mac.service.request('settingsBackupPreview')).preview
  assert.deepEqual(macPreview.changes.map(change => change.key), ['maxConnections'])
  assert.equal(macPreview.ignoredCount, 1)
  assert.match(macPreview.notes[0], /保留本机目录/)
  const windows = fixture({ platform: 'win32' })
  delete windows.state.askBrowserDownloadDestination
  windows.state.downloadDirectory = 'C:\\Downloads'
  windows.content = encode({ downloadDirectory: '/Users/another/Downloads', maxConnections: 32, askBrowserDownloadDestination: true })
  const winPreview = (await windows.service.request('settingsBackupPreview')).preview
  assert.equal(winPreview.ignoredCount, 2)
  assert.deepEqual(winPreview.changes.map(change => [change.key, change.after]), [['maxConnections', 16]])
  assert.ok(winPreview.notes.some(note => note.includes('16')))
})

test('a partially applied failure is compensated and verified without exposing the original error or changing credentials', async () => {
  const f = fixture()
  let attempts = 0
  f.dependencies.updateSettings = async patch => {
    f.updates.push(structuredClone(patch))
    if (++attempts === 1) {
      f.state.maxConnections = patch.maxConnections
      throw new Error('Auth=password-secret, Cookie: session-secret')
    }
    Object.assign(f.state, patch)
  }
  const preview = (await f.service.request('settingsBackupPreview')).preview
  const result = await f.service.request('settingsBackupApply', { token: preview.token })
  assert.equal(result.ok, false)
  assert.equal(result.rollback, 'succeeded')
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.deepEqual(f.updates, [{ maxConnections: 16, useCategoryFolders: true }, { maxConnections: 8 }])
  assert.deepEqual(f.state, original())
})

test('a lost successful apply reply is rolled back and a lost rollback reply is verified by readback', async () => {
  const f = fixture()
  f.dependencies.updateSettings = async patch => {
    f.updates.push(structuredClone(patch))
    Object.assign(f.state, patch)
    throw new Error('connection lost after commit')
  }
  const preview = (await f.service.request('settingsBackupPreview')).preview
  const result = await f.service.request('settingsBackupApply', { token: preview.token })
  assert.equal(result.rollback, 'succeeded')
  assert.deepEqual(f.state, original())
})

test('silent partial engine acceptance is not reported as successful import', async () => {
  const f = fixture()
  f.dependencies.updateSettings = async patch => { Object.assign(f.state, { maxConnections: patch.maxConnections }); return { ok: true } }
  const preview = (await f.service.request('settingsBackupPreview')).preview
  const result = await f.service.request('settingsBackupApply', { token: preview.token })
  assert.equal(result.ok, false)
  assert.equal(result.rollback, 'succeeded')
  assert.deepEqual(f.state, original())
})

test('failed compensation reports the exact unrestored settings and preserves unrelated concurrent edits', async () => {
  const f = fixture()
  let attempts = 0
  f.dependencies.updateSettings = async patch => {
    if (++attempts === 1) {
      f.state.maxConnections = patch.maxConnections
      f.state.futureSetting = 'new-unrelated-edit'
      throw new Error('partially applied')
    }
    throw new Error('rollback unavailable')
  }
  const preview = (await f.service.request('settingsBackupPreview')).preview
  const result = await f.service.request('settingsBackupApply', { token: preview.token })
  assert.equal(result.ok, false)
  assert.equal(result.rollback, 'partial')
  assert.equal(result.recoveryRequired, true)
  assert.deepEqual(result.unrestoredKeys, ['maxConnections'])
  assert.equal(f.state.futureSetting, 'new-unrelated-edit')
  assert.equal(f.state.httpProxyPassword, original().httpProxyPassword)
})

test('compensation does not overwrite a different newer value on the same setting', async () => {
  const f = fixture()
  f.dependencies.updateSettings = async () => { f.state.maxConnections = 12; throw new Error('concurrent edit') }
  const preview = (await f.service.request('settingsBackupPreview')).preview
  const result = await f.service.request('settingsBackupApply', { token: preview.token })
  assert.equal(result.rollback, 'partial')
  assert.equal(f.state.maxConnections, 12)
})

test('unavailable readback reports uncertainty and never claims rollback succeeded', async () => {
  const f = fixture()
  f.dependencies.updateSettings = async patch => {
    Object.assign(f.state, patch)
    f.dependencies.getSettings = async () => { throw new Error('engine unavailable') }
    throw new Error('lost response')
  }
  const preview = (await f.service.request('settingsBackupPreview')).preview
  const result = await f.service.request('settingsBackupApply', { token: preview.token })
  assert.equal(result.rollback, 'failed')
  assert.equal(result.recoveryRequired, true)
})

test('concurrent confirmations are serialized and a preview token is consumed once', async () => {
  const f = fixture()
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.dependencies.updateSettings = async patch => { f.updates.push(patch); await gate; Object.assign(f.state, patch) }
  const preview = (await f.service.request('settingsBackupPreview')).preview
  const first = f.service.request('settingsBackupApply', { token: preview.token })
  const second = f.service.request('settingsBackupApply', { token: preview.token })
  release()
  const results = await Promise.all([first, second])
  assert.equal(results[0].ok, true)
  assert.equal(results[1].ok, false)
  assert.equal(f.updates.length, 1)
})

test('real export and import file IO round-trip without leaving temporary files or writing during preview', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-settings-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'settings.json')
  const f = fixture({
    chooseExportPath: async () => path, chooseImportPath: async () => path,
    readTextFile: undefined, writeTextFile: undefined
  })
  const exported = await f.service.request('settingsBackupExport')
  assert.deepEqual(exported, { ok: true, exported: true, filename: 'settings.json' })
  const content = await readFile(path, 'utf8')
  assert.ok(!content.includes('keep-local'))
  assert.deepEqual(await readdir(root), ['settings.json'])
  f.state.maxConnections = 4
  const preview = (await f.service.request('settingsBackupPreview')).preview
  assert.deepEqual(f.updates, [])
  assert.deepEqual(preview.changes.map(change => [change.key, change.before, change.after]), [['maxConnections', 4, 8]])
  const applied = await f.service.request('settingsBackupApply', { token: preview.token })
  assert.equal(applied.ok, true)
  assert.equal(f.state.maxConnections, 8)
  assert.equal(await readFile(path, 'utf8'), content)
})

test('default reader rejects oversized files before parsing and export failures retain the previous destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ndm-settings-backup-bounds-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'large.json')
  await writeFile(path, 'x'.repeat(SETTINGS_BACKUP_MAX_BYTES + 1))
  const f = fixture({ chooseImportPath: async () => path, readTextFile: undefined })
  const result = await f.service.request('settingsBackupPreview')
  assert.equal(result.ok, false)
  assert.deepEqual(f.updates, [])
  const failed = fixture({ chooseExportPath: async () => root, writeTextFile: undefined })
  assert.equal((await failed.service.request('settingsBackupExport')).ok, false)
  assert.deepEqual(await readdir(root), ['large.json'])
})
