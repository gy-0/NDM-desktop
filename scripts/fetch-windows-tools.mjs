import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ARIA2_VERSION = '1.37.0'
const YT_DLP_VERSION = '2026.07.04'
const ARIA2_ARCHIVE_SHA256 = '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288'
const ARIA2_EXE_SHA256 = 'be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2'
const YT_DLP_EXE_SHA256 = '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8'

const target = join(process.cwd(), 'vendor', 'windows')
const aria2Exe = join(target, 'aria2c.exe')
const ytDlpExe = join(target, 'yt-dlp.exe')

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function verified(path, expected) {
  if (!existsSync(path)) return false
  return digest(await readFile(path)) === expected
}

async function download(url, expected) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = digest(bytes)
  if (actual !== expected) throw new Error(`SHA-256 不匹配：${basename(url)}\n预期 ${expected}\n实际 ${actual}`)
  return bytes
}

async function downloadText(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载许可证失败 ${response.status}: ${url}`)
  return response.text()
}

function extractZip(archive, output) {
  const command = process.platform === 'darwin'
    ? ['ditto', ['-x', '-k', archive, output]]
    : process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${output.replaceAll("'", "''")}' -Force`]]
      : ['unzip', ['-q', archive, '-d', output]]
  const result = spawnSync(command[0], command[1], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('无法解压 aria2 Windows 工具包')
}

async function findNamed(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const nested = await findNamed(path, name)
      if (nested) return nested
    }
  }
  return null
}

await mkdir(target, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'ndm-windows-tools-'))
try {
  if (!(await verified(aria2Exe, ARIA2_EXE_SHA256))) {
    const archive = join(temporary, 'aria2.zip')
    await writeFile(archive, await download(
      `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-win-64bit-build1.zip`,
      ARIA2_ARCHIVE_SHA256
    ))
    const extracted = join(temporary, 'aria2')
    await mkdir(extracted)
    extractZip(archive, extracted)
    const source = await findNamed(extracted, 'aria2c.exe')
    if (!source) throw new Error('aria2 Windows 包中没有 aria2c.exe')
    await copyFile(source, aria2Exe)
    if (!(await verified(aria2Exe, ARIA2_EXE_SHA256))) throw new Error('解压后的 aria2c.exe 校验失败')
  }

  if (!(await verified(ytDlpExe, YT_DLP_EXE_SHA256))) {
    await writeFile(ytDlpExe, await download(
      `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp.exe`,
      YT_DLP_EXE_SHA256
    ))
  }

  const licenses = join(target, 'Licenses')
  await mkdir(licenses, { recursive: true })
  await Promise.all([
    writeFile(join(licenses, 'aria2-GPL-2.0.txt'), await downloadText(
      `https://raw.githubusercontent.com/aria2/aria2/release-${ARIA2_VERSION}/COPYING`
    )),
    writeFile(join(licenses, 'yt-dlp-Unlicense.txt'), await downloadText(
      `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${YT_DLP_VERSION}/LICENSE`
    )),
    writeFile(join(licenses, 'yt-dlp-third-party.txt'), await downloadText(
      `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${YT_DLP_VERSION}/THIRD_PARTY_LICENSES.txt`
    ))
  ])
  await writeFile(join(target, 'VERSIONS.json'), JSON.stringify({
    aria2: { version: ARIA2_VERSION, sha256: ARIA2_EXE_SHA256 },
    ytDlp: { version: YT_DLP_VERSION, sha256: YT_DLP_EXE_SHA256 }
  }, null, 2))
  console.log(`Windows tools ready: aria2 ${ARIA2_VERSION}, yt-dlp ${YT_DLP_VERSION}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
