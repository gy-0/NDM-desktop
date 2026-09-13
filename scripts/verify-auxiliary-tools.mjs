import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hashes = {
  'macos-arm64': 'c36268f2ab67614ad8737586adab7fc1e1df85e0aef55421bd45f778f0868343',
  'macos-x86_64': 'c94d4bed9f1d8270320e17d3af1fa72d5fd4040efd5ee8a87c6d75d47aa6c5b4',
  'windows-x86_64': '7c1f49bf9f22f15f684ce1dcc76768f04b5dc3795281aef750d1e5ad78ff1459',
  'windows-arm64': '96036770333de330462158f592cf9474ccf6fe28c39d22a013971c1f12ad7526'
}
const sourceHash = '01b371683d160b912afa9b89d126dc33d84f0d4e1b5edd1716bbae12695bca29'
const sourceArchive = 'Sources/aria2-next-2.7.5.tar.gz'
async function verifyHash(path, expected) {
  if (!(await stat(path)).isFile() || createHash('sha256').update(await readFile(path)).digest('hex') !== expected) {
    throw new Error(`Auxiliary tool checksum mismatch: ${path}`)
  }
}

/** Build-time and post-signing check. Never rewrite the manifest to bless
 * modified binaries; runtime uses the same fixed upstream identity. */
export async function verifyAuxiliaryTools(directory, target = `${process.platform === 'darwin' ? 'macos' : 'windows'}-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`) {
  const expected = hashes[target]
  if (!expected) throw new Error(`Unsupported auxiliary engine target: ${target}`)
  const manifestBytes = await readFile(join(directory, 'aria2-next-manifest.json'))
  if (manifestBytes.length > 16384) throw new Error('Invalid auxiliary tool manifest')
  const manifest = JSON.parse(manifestBytes)
  if (manifest.version !== '2.7.5' || manifest.target !== target || manifest.binarySHA256 !== expected
      || manifest.sourceCommit !== 'a9784ea8e36ae83f360ff5157b60c72eb8d96375'
      || manifest.sourceSHA256 !== sourceHash || manifest.sourceArchive !== sourceArchive) throw new Error('Auxiliary tool manifest does not match the pinned release')
  const binary = join(directory, target.startsWith('windows-') ? 'aria2-next.exe' : 'aria2-next')
  await verifyHash(binary, expected)
  await verifyHash(join(directory, sourceArchive), sourceHash)
  const licenses = join(directory, 'Licenses/aria2-next-2.7.5')
  for (const name of ['aria2-next-GPL-2.0.txt', 'aria2-next-OpenSSL-exception.md', 'SOURCE.txt', 'boost.txt', 'curl.txt', 'expat.txt', 'libssh2.txt', 'libtorrent.txt', 'libtorrent-extra.txt', 'nghttp2.txt', 'openssl.txt', 'spdlog.txt', 'wslay.txt', 'zlib.txt']) {
    if (!(await readFile(join(licenses, name))).length) throw new Error(`Missing auxiliary license notice: ${name}`)
  }
  return { target, version: manifest.version, binarySHA256: expected, sourceSHA256: sourceHash }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyAuxiliaryTools(resolve(process.argv[2] ?? 'native/Vendor/Tools'), process.argv[3])))
}
