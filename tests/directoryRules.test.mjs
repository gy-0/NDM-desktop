import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  defaultDirectoryRules, directoryGlobMatches, directoryRuleExtension, isDirectoryForPlatform, resolveDirectoryRule,
  validateDirectoryRules, DIRECTORY_RULE_LIMITS
} from '../src/shared/directoryRules.ts'
import { DirectoryRulesService } from '../src/main/directoryRules.ts'

const rule = (overrides = {}) => ({ id: 'rule-1', name: '压缩包', enabled: true, directory: '/Projects/Archives', hosts: [], pathGlobs: [], extensions: ['zip'], ...overrides })
const config = (...rules) => ({ version: 1, enabled: true, rules })
const resolve = (value, overrides = {}) => resolveDirectoryRule(validateDirectoryRules(value), {
  url: 'https://example.com/file.zip', fallbackDirectory: '/Downloads/Compressed', platform: 'posix', ...overrides
})
function fixture(overrides = {}) {
  let stored = null
  const writes = [], applies = [], fallbackCalls = []
  const dependencies = {
    statePath: '/unused-directory-rules-fixture.json', platform: 'posix',
    storage: { read: async () => stored, write: async value => { writes.push(value); stored = value } },
    chooseDirectory: async () => '/Chosen/Folder',
    resolveFallbackDirectory: async sample => { fallbackCalls.push(sample); return '/Downloads/Compressed' },
    applyConfig: async value => { applies.push(value) }, ...overrides
  }
  return { service: new DirectoryRulesService(dependencies), dependencies, writes, applies, fallbackCalls, get stored() { return stored } }
}

test('directory rules default off and preserve explicit-directory then category-fallback precedence', () => {
  assert.deepEqual(defaultDirectoryRules(), { version: 1, enabled: false, rules: [] })
  assert.deepEqual(resolve(defaultDirectoryRules()), { source: 'fallback', directory: '/Downloads/Compressed' })
  assert.deepEqual(resolve(config(rule()), { explicitDirectory: '/My Project' }), { source: 'explicit', directory: '/My Project' })
  assert.deepEqual(resolve(config(rule())), { source: 'rule', directory: '/Projects/Archives', ruleID: 'rule-1', ruleName: '压缩包' })
  assert.equal(resolve(config(rule()), { url: 'https://example.com/file.pdf' }).directory, '/Downloads/Compressed')
  assert.throws(() => resolve(config(rule()), { explicitDirectory: 'relative/explicit' }), /手动/)
})

test('first matching rule wins; order, disabled rules and AND between groups are deterministic', () => {
  const specific = rule({ hosts: ['*.example.com', 'example.com'], pathGlobs: ['/release/*'], extensions: ['.ZIP', '7z'] })
  const other = rule({ id: 'rule-2', name: '另一规则', directory: '/Other' })
  assert.equal(resolve(config(specific, other), { url: 'https://cdn.example.com/release/a.zip' }).ruleID, 'rule-1')
  assert.equal(resolve(config(specific, other), { url: 'https://cdn.example.com/other/a.zip' }).ruleID, 'rule-2')
  assert.equal(resolve(config(specific, other), { url: 'https://different.test/release/a.zip' }).ruleID, 'rule-2')
  assert.equal(resolve(config(other, specific), { url: 'https://cdn.example.com/release/a.zip' }).ruleID, 'rule-2')
  assert.equal(resolve(config({ ...specific, enabled: false }, other), { url: 'https://cdn.example.com/release/a.zip' }).ruleID, 'rule-2')
  assert.equal(resolve(config(rule({ extensions: [], hosts: ['example.com'] })), { url: 'https://example.com/no-extension' }).source, 'rule')
})

test('hostname is canonical and case insensitive while URL pathname is anchored and excludes credentials, query and fragment', () => {
  const value = config(rule({ hosts: ['EXAMPLE.COM.'], pathGlobs: ['/File?.zip'], extensions: ['zip'] }))
  assert.equal(resolve(value, { url: 'https://user:password@EXAMPLE.COM./File1.zip?private=query#fragment' }).source, 'rule')
  assert.equal(resolve(value, { url: 'https://example.com/file1.zip' }).source, 'fallback')
  assert.equal(resolve(value, { url: 'https://example.com/prefix/File1.zip' }).source, 'fallback')
  assert.equal(resolve(config(rule({ hosts: [], pathGlobs: ['/file.zip*secret*'] })), { url: 'https://example.com/file.zip?secret=query' }).source, 'fallback')
})

test('question-mark glob matches one Unicode scalar and regex punctuation is literal with bounded matching', () => {
  assert.equal(directoryGlobMatches('/file?.zip', '/file1.zip'), true)
  assert.equal(directoryGlobMatches('/file?.zip', '/file.zip'), false)
  assert.equal(directoryGlobMatches('/file?.zip', '/file12.zip'), false)
  assert.equal(directoryGlobMatches('?', '💾'), true)
  assert.equal(directoryGlobMatches('/a[0-9].(zip)', '/a7.zip'), false)
  assert.equal(directoryGlobMatches('/a[0-9].(zip)', '/a[0-9].(zip)'), true)
  assert.equal(directoryGlobMatches('**/a*b?', '/aaabz'), true)
  assert.equal(directoryGlobMatches('*', ''), true)
  assert.equal(directoryGlobMatches('*a*a*a*a*a*a*a*a*b', 'a'.repeat(4000)), false)
  assert.equal(directoryGlobMatches('*', 'a'.repeat(DIRECTORY_RULE_LIMITS.candidateLength + 1)), false)
  assert.equal(directoryGlobMatches('*'.repeat(DIRECTORY_RULE_LIMITS.patternLength + 1), ''), false)
})

test('extension extraction preserves encoded filenames, last-extension semantics and explicit filename priority', () => {
  for (const [input, expected] of [
    ['https://a.test/archive.tar.GZ?token=x#part', 'gz'], ['https://a.test/%E6%96%87%E4%BB%B6%2EPDF', 'pdf'],
    ['.gitignore', ''], ['no-extension', ''], ['archive.tar.gz', 'gz'], ['magnet:?xt=anything.zip', ''], ['https://a.test/folder/', '']
  ]) assert.equal(directoryRuleExtension(input), expected)
  assert.equal(resolve(config(rule()), { url: 'https://a.test/download', filename: 'payload.zip' }).source, 'rule')
  assert.equal(resolve(config(rule()), { url: 'https://a.test/file.zip', filename: 'payload.pdf' }).source, 'fallback')
  assert.equal(resolve(config(rule()), { url: 'https://a.test/file.zip', filename: 'download' }).source, 'fallback')
})

test('schema rejects arbitrary regex, unknown properties, blank conditions, duplicated IDs and excessive bounds', () => {
  for (const value of [
    null, [], { version: 2, enabled: false, rules: [] }, { ...config(rule()), extra: true }, config(rule({ regexp: '(a+)+$' })),
    config(rule({ hosts: [], pathGlobs: [], extensions: [] })), config(rule(), rule()), config(rule({ extensions: [''] })),
    config(rule({ extensions: ['tar.gz'] })), config(rule({ hosts: ['https://user:secret@host'] })),
    config(rule({ hosts: ['example.com:443'] })), config(rule({ pathGlobs: ['relative/*'] })),
    config(rule({ directory: '../Downloads' })), config(rule({ directory: '/tmp/../Downloads' })),
    config(rule({ extensions: Array.from({ length: 9 }, (_, index) => `ext${index}`) })),
    config(rule({ pathGlobs: ['/' + 'a'.repeat(256)] })), config(...Array.from({ length: 33 }, (_, index) => rule({ id: `rule-${index}` }))),
    config(...Array.from({ length: 32 }, (_, index) => rule({ id: `rule-${index}`, pathGlobs: ['/' + 'a'.repeat(255), '/' + 'b'.repeat(255)] }))),
    JSON.parse('{"version":1,"enabled":false,"rules":[],"__proto__":{"polluted":true}}')
  ]) assert.throws(() => validateDirectoryRules(value))
  assert.equal({}.polluted, undefined)
  assert.deepEqual(validateDirectoryRules(config(rule({ extensions: ['.ZIP', 'zip', 'Pdf'], hosts: ['EXAMPLE.COM.'] }))).rules[0].extensions, ['zip', 'pdf'])
})

test('foreign directories remain stored but are skipped at match time; Windows absolute path rules reject device and relative paths', () => {
  const windows = rule({ directory: 'C:\\Downloads', id: 'windows' })
  assert.equal(resolve(config(windows, rule())).ruleID, 'rule-1')
  assert.deepEqual(resolve(config(windows)).ignoredRuleIDs, ['windows'])
  assert.equal(resolve(config(windows), { platform: 'win32', fallbackDirectory: 'D:\\Default' }).directory, 'C:\\Downloads')
  for (const path of ['C:\\Downloads', 'D:/Files', '\\\\server\\share\\folder']) assert.equal(isDirectoryForPlatform(path, 'win32'), true, path)
  for (const path of ['/Users/person', 'C:relative', '\\root-relative', '\\\\?\\C:\\Downloads', 'C:\\CON', 'C:\\dir\\..\\escape', 'C:\\dir:stream', 'C:\\trailing.']) assert.equal(isDirectoryForPlatform(path, 'win32'), false, path)
  assert.equal(isDirectoryForPlatform('C:\\Downloads', 'posix'), false)
})

test('default Get, directory chooser and preview do not write configuration or apply engine settings', async () => {
  const f = fixture()
  assert.deepEqual(await f.service.request('directoryRulesGet'), { ok: true, revision: 0, config: defaultDirectoryRules() })
  assert.deepEqual(await f.service.request('directoryRulesChooseDirectory', { directory: '/attacker/ignored' }), { ok: true, directory: '/Chosen/Folder' })
  const result = await f.service.request('directoryRulesPreview', { config: config(rule()), samples: [{ url: 'https://private-user:private-password@example.com/file.zip?private-token=1' }] })
  assert.equal(result.results[0].source, 'rule')
  assert.ok(!JSON.stringify(result).includes('private-'))
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.applies, [])
  await f.service.request('directoryRulesPreview', { config: config(rule()), samples: [{ url: 'https://example.com/file.zip', explicitDirectory: '/Manual' }] })
  assert.equal(f.fallbackCalls.length, 1, 'explicit destination does not require an engine default')
})

test('revision check serializes concurrent saves and retains an immutable config snapshot', async () => {
  const f = fixture()
  const value = config(rule())
  const first = f.service.request('directoryRulesSave', { expectedRevision: 0, config: value })
  value.rules[0].directory = '/mutated-after-request'
  const second = f.service.request('directoryRulesSave', { expectedRevision: 0, config: config(rule({ directory: '/Other' })) })
  const [saved, conflict] = await Promise.all([first, second])
  assert.equal(saved.ok, true)
  assert.equal(saved.revision, 1)
  assert.equal(saved.config.rules[0].directory, '/Projects/Archives')
  assert.equal(conflict.code, 'conflict')
  assert.equal(f.writes.length, 1)
  saved.config.rules[0].directory = '/mutated-result'
  assert.equal((await f.service.getConfig()).rules[0].directory, '/Projects/Archives')
})

test('real versioned JSON roundtrip has no preview URL or secrets and leaves only the 0600 config file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ndm-directory-rules-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'rules.json')
  const f = fixture({ statePath: path, storage: undefined })
  const saved = await f.service.request('directoryRulesSave', { expectedRevision: 0, config: config(rule()) })
  assert.equal(saved.ok, true)
  await f.service.request('directoryRulesPreview', { config: config(rule()), samples: [{ url: 'https://private-user:private-password@example.com/file.zip?private-token=1' }] })
  const file = await readFile(path, 'utf8'), document = JSON.parse(file)
  assert.equal(document.version, 1)
  assert.equal(document.revision, 1)
  assert.equal(document.enabled, true)
  assert.ok(Array.isArray(document.rules))
  assert.ok(!file.includes('private-'))
  assert.deepEqual(await readdir(directory), ['rules.json'])
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await new DirectoryRulesService(f.dependencies).request('directoryRulesGet'), saved)
})

test('failed save keeps old state and never applies unpersisted config; malformed disk state is never overwritten', async t => {
  const f = fixture()
  f.dependencies.storage.write = async () => { throw new Error('private disk path') }
  const result = await f.service.request('directoryRulesSave', { expectedRevision: 0, config: config(rule()) })
  assert.equal(result.code, 'storage')
  assert.equal(f.applies.length, 0)
  assert.deepEqual(await f.service.getConfig(), defaultDirectoryRules())
  const directory = await mkdtemp(join(tmpdir(), 'ndm-directory-rules-corrupt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'rules.json')
  for (const content of ['{broken', '{"version":99,"revision":0,"enabled":true,"rules":[]}', 'x'.repeat(70000)]) {
    await writeFile(path, content)
    const service = new DirectoryRulesService({ ...f.dependencies, statePath: path, storage: undefined })
    assert.equal((await service.request('directoryRulesGet')).ok, false)
    assert.equal((await service.request('directoryRulesSave', { expectedRevision: 0, config: config(rule()) })).ok, false)
    assert.equal(await readFile(path, 'utf8'), content)
  }
})

test('engine apply failure compensates both file and engine and advances revision to invalidate stale edits', async () => {
  const f = fixture()
  let attempts = 0
  f.dependencies.applyConfig = async value => { f.applies.push(value); if (++attempts === 1) throw new Error('private engine detail') }
  const result = await f.service.request('directoryRulesSave', { expectedRevision: 0, config: config(rule()) })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'apply')
  assert.equal(result.recoveryRequired, false)
  assert.match(result.error, /已恢复/)
  assert.ok(!result.error.includes('private'))
  assert.deepEqual(f.applies[1], defaultDirectoryRules())
  assert.deepEqual(await f.service.request('directoryRulesGet'), { ok: true, revision: 2, config: defaultDirectoryRules() })
  assert.equal(JSON.parse(f.stored).revision, 2)
})

test('failed engine compensation reports uncertainty and cannot claim config is applied', async () => {
  const f = fixture({ applyConfig: async () => { throw new Error('unavailable') } })
  const result = await f.service.request('directoryRulesSave', { expectedRevision: 0, config: config(rule()) })
  assert.equal(result.ok, false)
  assert.equal(result.recoveryRequired, true)
  assert.match(result.error, /未能确认/)
})

test('preview rejects invalid samples and never returns an unsafe raw exception', async () => {
  const f = fixture({ resolveFallbackDirectory: async () => { throw new Error('Cookie: secret') } })
  for (const samples of [[], Array.from({ length: 21 }, () => ({ url: 'https://example.com' })), [{ url: 'file:///private' }], [{ url: 'https://example.com', explicitDirectory: '../relative' }]]) {
    const result = await f.service.request('directoryRulesPreview', { config: config(rule()), samples })
    assert.equal(result.ok, false)
  }
  const result = await f.service.request('directoryRulesPreview', { config: config(rule()), samples: [{ url: 'https://example.com/file.zip' }] })
  assert.equal(result.ok, false)
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.deepEqual(f.writes, [])
})
