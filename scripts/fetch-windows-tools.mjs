import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ARIA2_VERSION = '1.37.0'
const YT_DLP_VERSION = '2026.07.04'
const FFMPEG_VERSION = '8.1.2-44-g7c533d0f86'
const ARIA2_ARCHIVE_SHA256 = '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288'
const ARIA2_EXE_SHA256 = 'be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2'
const YT_DLP_EXE_SHA256 = '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8'
const FFMPEG_ARCHIVE_SHA256 = '4fbc721c0168c2c7bc5f665fe4b5bbda2a098e701602cb4237d5390b1c6fb148'
const FFMPEG_EXE_SHA256 = '8ee152edc79f7ba99969b7fb590cfde438b46cb383952dec87e754db83788572'

const target = join(process.cwd(), 'vendor', 'windows')
const aria2Exe = join(target, 'aria2c.exe')
const ytDlpExe = join(target, 'yt-dlp.exe')
const ffmpegExe = join(target, 'ffmpeg.exe')
const ffmpegLicense = join(target, 'Licenses', 'ffmpeg-LGPL-2.1-or-later.txt')

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
  if (result.status !== 0) throw new Error('无法解压 Windows 工具包')
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

  if (!(await verified(ffmpegExe, FFMPEG_EXE_SHA256)) || !existsSync(ffmpegLicense)) {
    const archive = join(temporary, 'ffmpeg.zip')
    await writeFile(archive, await download(
      `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-20-13-45/ffmpeg-n${FFMPEG_VERSION}-win64-lgpl-8.1.zip`,
      FFMPEG_ARCHIVE_SHA256
    ))
    const extracted = join(temporary, 'ffmpeg')
    await mkdir(extracted)
    extractZip(archive, extracted)
    const executable = await findNamed(extracted, 'ffmpeg.exe')
    const license = await findNamed(extracted, 'LICENSE.txt')
    if (!executable || !license) throw new Error('FFmpeg Windows 包缺少 ffmpeg.exe 或许可证')
    await mkdir(join(target, 'Licenses'), { recursive: true })
    await copyFile(executable, ffmpegExe)
    await copyFile(license, ffmpegLicense)
    if (!(await verified(ffmpegExe, FFMPEG_EXE_SHA256))) throw new Error('解压后的 ffmpeg.exe 校验失败')
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
    ytDlp: { version: YT_DLP_VERSION, sha256: YT_DLP_EXE_SHA256 },
    ffmpeg: {
      version: FFMPEG_VERSION,
      sha256: FFMPEG_EXE_SHA256,
      license: 'LGPL-2.1-or-later'
    }
  }, null, 2))
  console.log(`Windows tools ready: aria2 ${ARIA2_VERSION}, yt-dlp ${YT_DLP_VERSION}, ffmpeg ${FFMPEG_VERSION}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
