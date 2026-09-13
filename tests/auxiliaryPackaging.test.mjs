import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyAuxiliaryTools } from '../scripts/verify-auxiliary-tools.mjs'

const metadata = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
// Load the installed builder at runtime, including when the test runner bundles
// this file. This checks the actual signing matcher, not a local reimplementation.
const require = createRequire(resolve('package.json'))
const { WinPackager } = require('app-builder-lib')

test('Windows extra-resource signing preserves the pinned helper and still signs other executables', async () => {
  const signed = []
  const packager = {
    platformSpecificBuildOptions: metadata.build.win,
    shouldSignFile: WinPackager.prototype.shouldSignFile,
    signIf: async path => { signed.push(path) }
  }
  for (const path of ['aria2-next.exe', 'vendor/windows/aria2-next.exe', 'C:\\NDM\\resources\\Tools\\windows\\aria2-next.exe']) {
    assert.equal(packager.shouldSignFile(path), false, path)
  }
  for (const path of ['NDM.exe', 'aria2c.exe', 'yt-dlp.exe', 'ffmpeg.exe', 'NDM-Windows-Setup.exe']) {
    assert.equal(packager.shouldSignFile(path), true, path)
  }
  // Adding one exclusion must not change the builder's fallback policy for DLLs.
  assert.equal(packager.shouldSignFile('chrome_elf.dll'), false)
  assert.equal(packager.shouldSignFile('chrome_elf.dll', true), true)
  const transformer = WinPackager.prototype.createTransformerForExtraFiles.call(packager, { appOutDir: resolve('dist/win-unpacked') })
  const tools = resolve('vendor/windows')
  assert.equal(transformer(join(tools, 'aria2-next.exe')), null)
  const other = join(tools, 'aria2c.exe')
  await transformer(other).afterCopyTransformer(other)
  assert.deepEqual(signed, [other])
})

test('Windows directory and signed-release paths verify packaged auxiliary resources after the builder', () => {
  const expand = (name, seen = []) => {
    assert.ok(!seen.includes(name), `Recursive npm script: ${name}`)
    assert.equal(typeof metadata.scripts[name], 'string')
    return metadata.scripts[name].split(/\s*&&\s*/).flatMap(command => {
      const child = /^npm run ([\w:-]+)$/.exec(command)
      return child ? expand(child[1], [...seen, name]) : [command]
    })
  }
  const verifier = 'node scripts/verify-auxiliary-tools.mjs dist/win-unpacked/resources/Tools/windows windows-x86_64'
  for (const name of ['package:win:dir', 'package:win', 'package:win:release']) {
    const commands = expand(name)
    const builderIndex = commands.findIndex(command => command.startsWith('electron-builder --win '))
    assert.ok(builderIndex >= 0, name)
    assert.ok(commands.indexOf(verifier) > builderIndex, name)
    assert.equal(commands.filter(command => command === verifier).length, 1, name)
  }
  const release = expand('package:win:release')
  assert.equal(release[0], 'node scripts/require-windows-signing.mjs')
  assert.equal(release.at(-1), 'node scripts/verify-windows-signatures.mjs')
  assert.ok(metadata.build.win.extraResources.some(item => item.from === 'vendor/windows' && item.to === 'Tools/windows'))
})

test('packaged auxiliary validation rejects a resigned binary, changed source, or missing license', async t => {
  // No downloads in tests. When prepared, exercise the verifier against the real
  // pinned artifacts; the packaging command always requires this verification.
  const prepared = ['vendor/windows', 'native/Vendor/Tools'].map(path => resolve(path))
    .find(path => existsSync(join(path, 'aria2-next-manifest.json')))
  if (!prepared) { t.skip('Run fetch:auxiliary-engine to prepare the pinned artifacts'); return }
  const manifest = JSON.parse(await readFile(join(prepared, 'aria2-next-manifest.json'), 'utf8'))
  const binaryName = manifest.target.startsWith('windows-') ? 'aria2-next.exe' : 'aria2-next'
  const root = await mkdtemp(join(tmpdir(), 'ndm-auxiliary-packaging-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Sources'))
  await copyFile(join(prepared, binaryName), join(root, binaryName))
  await copyFile(join(prepared, 'aria2-next-manifest.json'), join(root, 'aria2-next-manifest.json'))
  await copyFile(join(prepared, manifest.sourceArchive), join(root, manifest.sourceArchive))
  await cp(join(prepared, 'Licenses/aria2-next-2.7.5'), join(root, 'Licenses/aria2-next-2.7.5'), { recursive: true })
  assert.equal((await verifyAuxiliaryTools(root, manifest.target)).version, '2.7.5')
  const original = await readFile(join(root, binaryName))
  await writeFile(join(root, binaryName), Buffer.concat([original, Buffer.from('changed signing bytes')]))
  await assert.rejects(verifyAuxiliaryTools(root, manifest.target), /checksum mismatch/)
  await writeFile(join(root, binaryName), original)
  await writeFile(join(root, manifest.sourceArchive), 'changed source archive')
  await assert.rejects(verifyAuxiliaryTools(root, manifest.target), /checksum mismatch/)
  await copyFile(join(prepared, manifest.sourceArchive), join(root, manifest.sourceArchive))
  await rm(join(root, 'Licenses/aria2-next-2.7.5/aria2-next-GPL-2.0.txt'))
  await assert.rejects(verifyAuxiliaryTools(root, manifest.target), /ENOENT/)
})
