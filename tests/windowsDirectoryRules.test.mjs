import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsDownloadEngine } from '../src/main/windows/windowsEngine.ts'
import { DirectoryRulesService } from '../src/main/directoryRules.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ndm-windows-directories-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'engine'))
  const statePath = join(root, 'directory-rules.json')
  const engine = new WindowsDownloadEngine({ stateDirectory: join(root, 'engine'), directoryRulesPath: statePath,
    defaultDownloadDirectory: join(root, 'default'), aria2Path: '', ytDlpPath: '', ffmpegPath: '' }, { onStatus() {}, onEvent() {} })
  const service = new DirectoryRulesService({ statePath, chooseDirectory: async () => null,
    resolveFallbackDirectory: async sample => (await engine.request('directoryRulesFallback', sample)).directory,
    applyConfig: async () => { await engine.request('directoryRulesReload') } })
  const config = directory => ({ version: 1, enabled: true, rules: [{ id: 'archives', name: 'Archives', enabled: true,
    directory, hosts: ['*.example.test'], pathGlobs: [], extensions: ['zip'] }] })
  const add = extra => engine.request('add', { url: 'https://cdn.example.test/file.bin', filename: 'archive.zip', autoStart: false, ...extra })
  return { root, statePath, engine, service, config, add }
}

test('directory save acknowledgement drives actual task creation and keeps explicit choices exact', async t => {
  const f = await fixture(t), target = join(f.root, 'rules')
  const saved = await f.service.request('directoryRulesSave', { expectedRevision: 0, config: f.config(target) })
  assert.equal(saved.ok, true)
  assert.equal((await f.add()).task.folderPath, target)
  const explicit = join(f.root, 'chosen')
  assert.equal((await f.add({ folderPath: explicit })).task.folderPath, explicit)
  const next = join(f.root, 'next')
  assert.equal((await f.service.request('directoryRulesSave', { expectedRevision: saved.revision, config: f.config(next) })).ok, true)
  assert.equal((await f.add()).task.folderPath, next)
  assert.equal((await f.engine.request('list')).tasks.find(task => task.id === 1).folderPath, target)
})

test('Windows category fallback is applied only when no exact directory override is selected', async t => {
  const f = await fixture(t)
  await f.engine.request('updateSettings', { useCategoryFolders: true })
  assert.equal((await f.add()).task.folderPath, join(f.root, 'default', 'Compressed'))
  assert.equal((await f.add({ folderPath: join(f.root, 'project') })).task.folderPath, join(f.root, 'project'))
})

test('corrupt rules do not replace download history or prevent explicit-directory creation', async t => {
  const f = await fixture(t)
  await writeFile(f.statePath, '{"version":99,"revision":0,"enabled":true,"rules":[]}')
  await assert.rejects(f.add(), /规则/)
  assert.equal((await f.engine.request('list')).tasks.length, 0)
  assert.equal((await f.add({ folderPath: join(f.root, 'chosen') })).ok, true)
})
