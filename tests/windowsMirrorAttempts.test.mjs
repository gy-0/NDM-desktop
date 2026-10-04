import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rename, mkdir, realpath } from 'node:fs/promises'
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

test('publication recovers both intent-only and linked-before-commit boundaries', async () => {
  for (const alreadyLinked of [false, true]) {
    const root = join(await mkdtemp(join(tmpdir(), 'ndm-mirror-publish-')), 'work')
    const journal = new WindowsMirrorAttempts(root, 1, sources)
    const first = await journal.current(), output = join(root, 'final.bin')
    const payload = join(first.directory, 'payload.bin')
    await writeFile(payload, 'complete backup')
    await journal.preparePublication(1, output, 15)
    if (alreadyLinked) {
      const { link } = await import('node:fs/promises')
      await link(payload, output)
    }
    const recovered = new WindowsMirrorAttempts(root, 1, sources)
    assert.equal(await recovered.publish(), join(await realpath(root), 'final.bin'))
    assert.equal(await new WindowsMirrorAttempts(root, 1, sources).publish(), join(await realpath(root), 'final.bin'))
    assert.equal(await readFile(output, 'utf8'), 'complete backup')
    await assert.rejects(recovered.advance(1), /正在交付/)
    const { unlink } = await import('node:fs/promises')
    await unlink(output)
    await assert.rejects(recovered.publish(), /被移走/)
  }
})

test('publication rejects collisions and changed settled payload without replacing files', async () => {
  for (const mode of ['collision', 'changed']) {
    const root = join(await mkdtemp(join(tmpdir(), 'ndm-mirror-publish-')), 'work')
    const journal = new WindowsMirrorAttempts(root, 1, sources)
    const first = await journal.current(), output = join(root, 'final.bin')
    const payload = join(first.directory, 'payload.bin')
    await writeFile(payload, 'backup')
    await journal.preparePublication(1, output, 6)
    if (mode === 'collision') await writeFile(output, 'user file')
    else await writeFile(payload, 'changed payload')
    await assert.rejects(new WindowsMirrorAttempts(root, 1, sources).publish(), mode === 'collision' ? /已存在/ : /已变化/)
    if (mode === 'collision') assert.equal(await readFile(output, 'utf8'), 'user file')
    else await assert.rejects(readFile(output), { code: 'ENOENT' })
  }
})

test('malformed publication receipts fail closed on reopen', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'ndm-mirror-publish-')), 'work')
  await new WindowsMirrorAttempts(root, 1, sources).current()
  const path = join(root, 'attempts.json'), record = JSON.parse(await readFile(path, 'utf8'))
  for (const publication of [null, false, {}, { phase: 'published' }]) {
    await writeFile(path, JSON.stringify({ ...record, publication }))
    await assert.rejects(new WindowsMirrorAttempts(root, 1, sources).current(), /交付记录无效/)
  }
})

test('mirror cleanup retains published output and refuses unknown staging content', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ndm-mirror-cleanup-')), root = join(base, 'work')
  const journal = new WindowsMirrorAttempts(root, 1, sources), first = await journal.current()
  await writeFile(join(first.directory, 'payload.bin'), 'complete')
  const output = join(base, 'final.bin')
  await journal.preparePublication(1, output, 8); await journal.publish()
  const unknown = join(first.directory, 'user-note')
  await writeFile(unknown, 'keep')
  await assert.rejects(journal.cleanup(), /未知/)
  assert.equal(await readFile(join(first.directory, 'payload.bin'), 'utf8'), 'complete')
  const { unlink } = await import('node:fs/promises'); await unlink(unknown)
  await journal.cleanup()
  assert.equal(await readFile(output, 'utf8'), 'complete')
  await assert.rejects(readFile(join(root, 'attempts.json')), { code: 'ENOENT' })
})

test('published deletion refuses replacement and cleanup resumes after partial removal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ndm-mirror-cleanup-')), root = join(base, 'work')
  const journal = new WindowsMirrorAttempts(root, 1, sources), first = await journal.current()
  await writeFile(join(first.directory, 'payload.bin'), 'complete')
  const output = join(base, 'final.bin')
  await journal.preparePublication(1, output, 8); await journal.publish()
  const { unlink, rmdir } = await import('node:fs/promises')
  await unlink(output); await writeFile(output, 'user replacement')
  await assert.rejects(journal.deletePublished(), /已变化/)
  assert.equal(await readFile(output, 'utf8'), 'user replacement')
  const path = join(root, 'attempts.json'), record = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...record, cleanup: true }))
  await unlink(join(first.directory, 'payload.bin')); await rmdir(first.directory)
  const recovered = new WindowsMirrorAttempts(root, 1, sources)
  await assert.rejects(recovered.current(), /正在清理/)
  await recovered.cleanup()
  assert.equal(await readFile(output, 'utf8'), 'user replacement')
})

test('renewal keeps the owned attempt and survives reopen and a later new run', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ndm-mirror-renew-')), root = join(base, 'work')
  const journal = new WindowsMirrorAttempts(root, 1, sources)
  await journal.current(); const second = await journal.advance(1)
  await writeFile(join(second.directory, 'payload.bin'), 'retained prefix')
  const alias = 'https://backup.example/renewed-link'
  const renewed = await journal.renew(2, alias)
  assert.equal(renewed.directory, second.directory)
  assert.equal(renewed.url, alias)
  const recovered = new WindowsMirrorAttempts(root, 1, sources)
  assert.deepEqual(await recovered.current(), renewed)
  assert.equal(await readFile(join(second.directory, 'payload.bin'), 'utf8'), 'retained prefix')
  assert.deepEqual(await recovered.effectiveSources(), [sources[0], alias])
  const next = new WindowsMirrorAttempts(join(base, 'next'), 1, await recovered.effectiveSources())
  await next.current(); assert.equal((await next.advance(1)).url, alias)
  await assert.rejects(recovered.renew(1, alias), /当前状态/)
  await assert.rejects(recovered.renew(2, 'file:///tmp/file'), /地址无效/)
})
