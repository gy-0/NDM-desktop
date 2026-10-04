import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsMirrorAttempts } from '../src/main/windows/mirrorAttempts.ts'
const sources = ['https://primary.example/file', 'https://backup.example/file']

test('mirror source selection survives relaunch without adopting previous bytes', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'ndm-mirror-journal-')), 'work')
  const journal = new WindowsMirrorAttempts(root, 1, sources)
  const first = await journal.current()
  await writeFile(join(first.directory, 'payload'), 'first source partial')
  const results = await Promise.allSettled([journal.advance(1), journal.advance(1)])
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected')
  const second = results[0].value
  assert.equal(second.url, sources[1]); assert.notEqual(second.directory, first.directory)
  assert.deepEqual(await new WindowsMirrorAttempts(root, 1, sources).current(), second)
  assert.equal(await readFile(join(first.directory, 'payload'), 'utf8'), 'first source partial')
  await assert.rejects(journal.advance(2), /所有镜像/)
  await assert.rejects(new WindowsMirrorAttempts(root, 1, [...sources].reverse()).current(), /不一致/)
  await assert.rejects(new WindowsMirrorAttempts(root, 2, sources).current(), /不一致/)
})

test('mirror journal preserves orphan and substituted directories', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'ndm-mirror-journal-')), 'work')
  const journal = new WindowsMirrorAttempts(root, 1, sources)
  const first = await journal.current()
  await mkdir(join(root, 'attempt-2'))
  await writeFile(join(root, 'attempt-2', 'payload'), 'orphan')
  await assert.rejects(journal.advance(1), { code: 'EEXIST' })
  assert.equal((await new WindowsMirrorAttempts(root, 1, sources).current()).generation, 1)
  await rename(first.directory, first.directory + '-saved')
  await mkdir(first.directory)
  await assert.rejects(journal.current(), /被替换/)
  await assert.rejects(new WindowsMirrorAttempts(root, 1, sources).current(), /被替换/)
  assert.equal(await readFile(join(root, 'attempt-2', 'payload'), 'utf8'), 'orphan')
})
