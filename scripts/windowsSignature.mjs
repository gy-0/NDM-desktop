import { spawnSync } from 'node:child_process'

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  throw new TypeError('PE 内容必须是 Buffer 或 Uint8Array')
}

export function inspectAuthenticode(bytes) {
  const buffer = asBuffer(bytes)
  if (buffer.length < 64 || buffer.readUInt16LE(0) !== 0x5a4d) {
    return { present: false, reason: '不是有效的 PE 文件' }
  }
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset > buffer.length - 24 || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    return { present: false, reason: 'PE 头无效' }
  }
  const optionalOffset = peOffset + 24
  if (optionalOffset > buffer.length - 2) return { present: false, reason: 'PE 可选头缺失' }
  const magic = buffer.readUInt16LE(optionalOffset)
  const numberOfDirectoriesOffset = magic === 0x10b
    ? optionalOffset + 92
    : magic === 0x20b
      ? optionalOffset + 108
      : -1
  const dataDirectoriesOffset = magic === 0x10b
    ? optionalOffset + 96
    : magic === 0x20b
      ? optionalOffset + 112
      : -1
  if (numberOfDirectoriesOffset < 0) return { present: false, reason: '不支持的 PE 可选头' }
  if (numberOfDirectoriesOffset > buffer.length - 4) return { present: false, reason: 'PE 数据目录缺失' }
  if (buffer.readUInt32LE(numberOfDirectoriesOffset) <= 4) return { present: false, reason: '没有证书表目录' }
  const certificateEntry = dataDirectoriesOffset + (4 * 8)
  if (certificateEntry > buffer.length - 8) return { present: false, reason: 'PE 证书表目录越界' }
  const offset = buffer.readUInt32LE(certificateEntry)
  const size = buffer.readUInt32LE(certificateEntry + 4)
  if (offset === 0 || size === 0) return { present: false, reason: '未嵌入 Authenticode 签名' }
  if (size < 8 || offset > buffer.length - size) return { present: false, reason: 'PE 证书表越界' }
  const length = buffer.readUInt32LE(offset)
  const revision = buffer.readUInt16LE(offset + 4)
  const certificateType = buffer.readUInt16LE(offset + 6)
  if (length < 8 || length > size || offset > buffer.length - length) {
    return { present: false, reason: 'WIN_CERTIFICATE 长度无效' }
  }
  if (revision !== 0x0200 || certificateType !== 0x0002) {
    return { present: false, reason: 'WIN_CERTIFICATE 不是 PKCS#7 Authenticode 签名' }
  }
  return { present: true, offset, size, length, revision, certificateType }
}

export function verifyAuthenticodeWithSystem(path) {
  if (process.platform === 'win32') {
    const quotedPath = path.replaceAll("'", "''")
    const script = `$s = Get-AuthenticodeSignature -LiteralPath '${quotedPath}'; Write-Output $s.Status; if ($s.Status -ne "Valid") { exit 1 }`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    return {
      available: !result.error,
      valid: result.status === 0,
      detail: String(result.stdout || result.stderr || result.error?.message || '').trim()
    }
  }
  const result = spawnSync('osslsigncode', ['verify', '-in', path], { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') {
    return { available: false, valid: false, detail: '本机未安装 osslsigncode' }
  }
  return {
    available: true,
    valid: result.status === 0,
    detail: String(result.stdout || result.stderr || result.error?.message || '').trim()
  }
}
