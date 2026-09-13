import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeDirectoryShortcuts, updateDirectoryShortcuts, explicitComposerDirectory } from '../src/renderer/src/lib/directoryShortcuts.ts'
import { resolveDirectoryRule } from '../src/shared/directoryRules.ts'
import { DirectoryRulesService } from '../src/main/directoryRules.ts'

test('shortcut storage repairs invalid entries, deduplicates and bounds each list', () => {
  const state = decodeDirectoryShortcuts(JSON.stringify({ version: 1,
    favorites: ['/Downloads', '/Downloads', '../escape', '/bad\0path', 'C:\\Downloads'],
    recent: Array.from({ length: 100 }, (_, index) => `/Downloads/${index}`) }))
  assert.deepEqual(state.favorites, ['/Downloads', 'C:\\Downloads'])
  assert.equal(state.recent.length, 20)
  assert.deepEqual(decodeDirectoryShortcuts('{broken'), { version: 1, favorites: [], recent: [] })
})

test('choosing a recent directory moves it to the front without losing favorites', () => {
  let state = { version: 1, favorites: ['/a'], recent: ['/a', '/b', '/c'] }
  state = updateDirectoryShortcuts(state, '/c', 'remember')
  assert.deepEqual(state.recent, ['/c', '/a', '/b'])
  assert.deepEqual(state.favorites, ['/a'])
  state = updateDirectoryShortcuts(state, '/b', 'favorite')
  assert.deepEqual(state.favorites, ['/b', '/a'])
  assert.deepEqual(updateDirectoryShortcuts(state, '/b', 'favorite').favorites, ['/a'])
})

const config = { version: 1, enabled: true, rules: [{ id: 'archives', name: '归档', enabled: true, directory: '/Archives', hosts: [], pathGlobs: [], extensions: ['zip'] }] }
test('automatic Composer destination permits directory rules and explicit choice overrides them', () => {
  const sample = { url: 'https://example.com/package.zip', fallbackDirectory: '/Downloads', platform: 'posix' }
  assert.equal(resolveDirectoryRule(config, { ...sample, explicitDirectory: explicitComposerDirectory(false, '/Downloads') }).directory, '/Archives')
  assert.equal(resolveDirectoryRule(config, { ...sample, explicitDirectory: explicitComposerDirectory(true, '/Downloads') }).directory, '/Downloads')
  assert.equal(explicitComposerDirectory(false, '/PreviousManualChoice'), undefined)
})

test('Composer preview resolves saved config while ignoring a supplied replacement config', async () => {
  const service = new DirectoryRulesService({ statePath: '/unused', platform: 'posix',
    storage: { read: async () => JSON.stringify({ ...config, revision: 2 }), write: async () => assert.fail('preview cannot save') },
    chooseDirectory: async () => null, resolveFallbackDirectory: async () => '/Downloads' })
  const reply = await service.request('directoryRulesResolve', { config: { version: 1, enabled: false, rules: [] }, samples: [{ url: 'https://example.com/archive.zip' }] })
  assert.equal(reply.ok, true)
  assert.equal(reply.results[0].directory, '/Archives')
})
