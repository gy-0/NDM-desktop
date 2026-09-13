import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const version = '2.7.5'
const commit = 'a9784ea8e36ae83f360ff5157b60c72eb8d96375'
const sourceSHA256 = '01b371683d160b912afa9b89d126dc33d84f0d4e1b5edd1716bbae12695bca29'
const hashes = {
  'macos-arm64': 'c36268f2ab67614ad8737586adab7fc1e1df85e0aef55421bd45f778f0868343',
  'macos-x86_64': 'c94d4bed9f1d8270320e17d3af1fa72d5fd4040efd5ee8a87c6d75d47aa6c5b4',
  'windows-x86_64': '7c1f49bf9f22f15f684ce1dcc76768f04b5dc3795281aef750d1e5ad78ff1459',
  'windows-arm64': '96036770333de330462158f592cf9474ccf6fe28c39d22a013971c1f12ad7526'
}
const target = process.argv[2] ?? `${process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`
const expected = hashes[target]
if (!expected) throw new Error(`Unsupported auxiliary engine target: ${target}`)
const windows = target.startsWith('windows-')
const destination = resolve(windows ? 'vendor/windows' : 'native/Vendor/Tools')
const suffix = windows ? '.exe' : ''
const asset = `aria2-next-${version}-${target}${suffix}`
const binaryURL = `https://github.com/AnInsomniacy/aria2-next/releases/download/v${version}/${asset}`
const sourceURL = `https://api.github.com/repos/AnInsomniacy/aria2-next/tarball/${commit}`
const binary = join(destination, `aria2-next${suffix}`)
const archive = join(destination, 'Sources', `aria2-next-${version}.tar.gz`)
const licenses = join(destination, 'Licenses', `aria2-next-${version}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const verified = async (path, expected) => existsSync(path) && hash(await readFile(path)) === expected

async function obtain(path, expected, url, cachePath) {
  if (await verified(path, expected)) return
  let bytes
  if (await verified(cachePath, expected)) bytes = await readFile(cachePath)
  else {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Auxiliary engine download failed: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (hash(bytes) !== expected) throw new Error(`Auxiliary engine checksum mismatch: ${path}`)
  await mkdir(join(path, '..'), { recursive: true })
  const staged = `${path}.${process.pid}.tmp`
  await writeFile(staged, bytes)
  await rename(staged, path)
}

await obtain(binary, expected, binaryURL, join(tmpdir(), `ndm-${asset}`))
await chmod(binary, 0o755)
await obtain(archive, sourceSHA256, sourceURL, join(tmpdir(), `ndm-aria2-next-source-${version}.tar.gz`))
await mkdir(licenses, { recursive: true })
const notices = {
  'aria2-next-GPL-2.0.txt': 'COPYING',
  'aria2-next-OpenSSL-exception.md': 'docs/licenses/OPENSSL.md',
  'boost.txt': 'third_party/boost/LICENSE_1_0.txt',
  'curl.txt': 'third_party/curl/COPYING',
  'expat.txt': 'third_party/expat/COPYING',
  'libssh2.txt': 'third_party/libssh2/COPYING',
  'libtorrent.txt': 'third_party/libtorrent/COPYING',
  'libtorrent-extra.txt': 'third_party/libtorrent/LICENSE',
  'nghttp2.txt': 'third_party/nghttp2/COPYING',
  'openssl.txt': 'third_party/openssl/LICENSE.txt',
  'spdlog.txt': 'third_party/spdlog/LICENSE',
  'wslay.txt': 'third_party/wslay/COPYING',
  'zlib.txt': 'third_party/zlib/LICENSE'
}
for (const [name, path] of Object.entries(notices)) {
  const result = spawnSync('tar', ['-xOf', archive, `AnInsomniacy-aria2-next-${commit.slice(0, 7)}/${path}`], { maxBuffer: 1024 * 1024 })
  if (result.status !== 0 || !result.stdout?.length) throw new Error(`Cannot extract auxiliary engine license: ${path}`)
  await writeFile(join(licenses, name), result.stdout)
}
const manifest = { version, target, binarySHA256: expected, binaryURL, sourceCommit: commit, sourceSHA256, sourceURL,
  sourceArchive: `Sources/aria2-next-${version}.tar.gz`, license: 'GPL-2.0-or-later with upstream OpenSSL linking exception' }
await writeFile(join(destination, 'aria2-next-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(join(licenses, 'SOURCE.txt'), `Aria2 Next ${version}\nUnmodified upstream executable: ${binaryURL}\nSource commit: ${commit}\nThe corresponding upstream source archive, vendored dependency sources, build scripts and original notices are included at ../../Sources/aria2-next-${version}.tar.gz.\nSQLite source in third_party/sqlite is dedicated to the public domain.\nNDM communicates with this helper through local JSON-RPC.\n`)
console.log(`Verified Aria2 Next ${version} (${target}), source archive and license notices.`)
