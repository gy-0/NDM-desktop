export type FileDeliveryAction = 'open' | 'preview' | 'reveal' | 'share'
export type FileDeliveryHandler = () => boolean | string | void | Promise<boolean | string | void>

const FAILED: Record<FileDeliveryAction, string> = {
  open: '未能打开文件，请检查保存位置',
  preview: '找不到文件，无法预览',
  reveal: '找不到文件或保存位置',
  share: '暂时无法分享，请重试'
}

const UNAVAILABLE: Record<FileDeliveryAction, string> = {
  open: '暂时无法打开文件，请重试',
  preview: '暂时无法预览，请重试',
  reveal: '暂时无法定位文件，请重试',
  share: '暂时无法分享，请重试'
}

/** Electron openPath returns an empty string on success; other file commands
 * return a boolean. Keep OS error details out of this small UI notice. */
export async function runFileDeliveryAction(action: FileDeliveryAction, handler: FileDeliveryHandler): Promise<string | null> {
  try {
    const result = await handler()
    return result === false || (typeof result === 'string' && result.length > 0)
      ? FAILED[action]
      : null
  } catch {
    return UNAVAILABLE[action]
  }
}

const FILE_KINDS: Record<string, string> = {
  pdf: 'PDF 文档', epub: 'EPUB 电子书',
  doc: 'Word 文档', docx: 'Word 文档',
  xls: 'Excel 表格', xlsx: 'Excel 表格',
  ppt: 'PowerPoint 演示文稿', pptx: 'PowerPoint 演示文稿',
  txt: '文本文档', md: 'Markdown 文档', csv: 'CSV 表格',
  mp4: 'MP4 视频', mov: 'QuickTime 视频', mkv: 'MKV 视频', webm: 'WebM 视频',
  mp3: 'MP3 音频', m4a: 'M4A 音频', wav: 'WAV 音频', flac: 'FLAC 音频',
  jpg: 'JPEG 图片', jpeg: 'JPEG 图片', png: 'PNG 图片', heic: 'HEIC 图片', gif: 'GIF 图片', webp: 'WebP 图片',
  zip: 'ZIP 压缩包', rar: 'RAR 压缩包', '7z': '7Z 压缩包',
  dmg: '磁盘映像', pkg: '安装包', exe: 'Windows 应用', msi: 'Windows 安装包',
  srt: '字幕文件', vtt: '字幕文件', ass: '字幕文件'
}

export function deliveryFileKind(filename: string): string {
  const name = filename.split(/[\\/]/).pop() || ''
  const separator = name.lastIndexOf('.')
  if (separator <= 0 || separator === name.length - 1) return '文件'
  const extension = name.slice(separator + 1).toLowerCase()
  return FILE_KINDS[extension] || (/^[a-z0-9]{1,8}$/.test(extension) ? `${extension.toUpperCase()} 文件` : '文件')
}
