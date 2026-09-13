/**
 * aria2 input-file structure adapted from Motrix Next batchHelpers.ts.
 * Copyright (c) 2025-present AnInsomniacy, MIT.
 * Source: https://github.com/AnInsomniacy/motrix-next/blob/83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3/src/shared/utils/batchHelpers.ts
 * See THIRD_PARTY.md for the license. NDM adds strict, line-addressed validation.
 */
import { decodeThunderLink } from './thunderLink'

export const DOWNLOAD_IMPORT_LIMITS = Object.freeze({ bytes: 1_048_576, lines: 10_000, lineLength: 16_384, tasks: 500, mirrors: 32, options: 64, headers: 32 })
export type DownloadImportIssue = { line: number; code: string; message: string }
export type DownloadImportOption = { line: number; name: string; value: string }
export type DownloadImportFields = { filename?: string; folderPath?: string; headers?: string[]; autoStart?: boolean }
export type DownloadImportEntry = {
  id: string
  line: number
  uris: string[]
  options: DownloadImportOption[]
  fields: DownloadImportFields
  issues: DownloadImportIssue[]
}
export type ParsedDownloadImport = { entries: DownloadImportEntry[]; issues: DownloadImportIssue[] }
export type DownloadImportPreview = ParsedDownloadImport & { ok: true; sessionID: string; sourceName: string }
export type DownloadImportPreviewReply = DownloadImportPreview | { ok: true; cancelled: true }
export type DownloadImportCreateRequest = DownloadImportFields & { url: string; mirrors: string[]; creationKey: string }
export type DownloadImportResult = { id: string; status: 'accepted' | 'failed' | 'unconfirmed'; taskID?: number; error?: string }
export type DownloadImportCreateReply = { ok: true; results: DownloadImportResult[] }
export type DownloadImportSessionSnapshot = {
  preview: DownloadImportPreview
  /** Kept in encrypted main-process storage; never browser localStorage. */
  input: string
  results: DownloadImportResult[]
  autoStart?: boolean
}
export type DownloadImportStatusReply = { ok: true; session: DownloadImportSessionSnapshot | null; warning?: string }

const optionAssignment = /^[A-Za-z0-9][A-Za-z0-9-]*=/
const controls = /[\u0000-\u001f\u007f-\u009f]/
const headerToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const forbiddenHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'range', 'if-range', 'accept-encoding', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade'])

function countLeadingSpaces(line: string): number { return line.match(/^[ \t]*/)?.[0].length ?? 0 }

// Retains the upstream common-indent handling for indented pasted blocks.
function trimCommonInputIndent(lines: string[]): string[] {
  const contentIndents = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed && !trimmed.startsWith('#') && !optionAssignment.test(trimmed)
  }).map(countLeadingSpaces)
  if (!contentIndents.length) return lines
  const commonIndent = Math.min(...contentIndents)
  return commonIndent > 0 ? lines.map(line => line.slice(Math.min(commonIndent, countLeadingSpaces(line)))) : lines
}

function validFilename(value: string): boolean {
  return !!value && value === value.trim() && new TextEncoder().encode(value).length <= 255
    && !controls.test(value) && !/[<>:"/\\|?*]/.test(value) && !/[. ]$/.test(value)
    && !/^(?:\.+|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(value)
}

function validDirectory(value: string): boolean {
  return !!value && value === value.trim() && value.length <= 4096 && !controls.test(value)
    && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))
    && !value.split(/[\\/]/).some(part => part === '..' || part === '.')
}

function normalizeURI(value: string): string | null {
  if (/^thunder:\/\//i.test(value)) return decodeThunderLink(value)
  if (!/^(?:https?|ftp):\/\//i.test(value) || /[\\\u0000-\u0020\u007f-\u009f]/.test(value)) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'ftp:'].includes(url.protocol) && !!url.hostname ? value : null
  } catch { return null }
}

/** Strict subset: unsupported options are errors on their task, never dropped. */
export function parseDownloadImport(text: string): ParsedDownloadImport {
  const entries: DownloadImportEntry[] = []
  const issues: DownloadImportIssue[] = []
  const globalIssue = (line: number, code: string, message: string) => issues.push({ line, code, message })
  if (new TextEncoder().encode(text).length > DOWNLOAD_IMPORT_LIMITS.bytes) {
    globalIssue(1, 'tooLarge', '清单不能超过 1 MiB。'); return { entries, issues }
  }
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (rawLines.length > DOWNLOAD_IMPORT_LIMITS.lines) {
    globalIssue(DOWNLOAD_IMPORT_LIMITS.lines + 1, 'tooManyLines', '清单不能超过 10000 行。'); return { entries, issues }
  }
  let current: DownloadImportEntry | undefined
  const addIssue = (line: number, code: string, message: string) => {
    const issue = { line, code, message }
    if (current) current.issues.push(issue)
    else issues.push(issue)
  }
  for (const [index, rawLine] of trimCommonInputIndent(rawLines).entries()) {
    const line = index + 1
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (rawLine.length > DOWNLOAD_IMPORT_LIMITS.lineLength) {
      // Global structural failures must not leave a truncated task creatable.
      globalIssue(line, 'lineTooLong', '单行不能超过 16384 个字符。'); continue
    }
    if (/^[ \t]/.test(rawLine)) {
      if (!current) { globalIssue(line, 'orphanOption', '选项前必须有一行下载地址。'); continue }
      if (!optionAssignment.test(trimmed)) { addIssue(line, 'invalidOption', '缩进行必须是 name=value 选项。'); continue }
      const separator = trimmed.indexOf('=')
      const name = trimmed.slice(0, separator)
      const value = trimmed.slice(separator + 1)
      current.options.push({ line, name, value })
      if (current.options.length > DOWNLOAD_IMPORT_LIMITS.options) { addIssue(line, 'tooManyOptions', '每个任务不能超过 64 个选项。'); continue }
      if (!['out', 'dir', 'header', 'referer', 'user-agent', 'pause'].includes(name)) {
        addIssue(line, 'unsupportedOption', `暂不支持选项 ${name}；请保留原清单并修改该项后重试。`); continue
      }
      if (name !== 'header' && current.options.filter(option => option.name === name).length > 1) {
        addIssue(line, 'duplicateOption', `选项 ${name} 不能重复。`); continue
      }
      if (name === 'out') {
        if (!validFilename(value)) addIssue(line, 'invalidFilename', 'out 必须是安全的单个文件名，不能含目录或保留名称。')
        else current.fields.filename = value
      } else if (name === 'dir') {
        if (!validDirectory(value)) addIssue(line, 'invalidDirectory', 'dir 必须是明确的绝对目录，不能含 . 或 .. 路径段。')
        else current.fields.folderPath = value
      } else if (name === 'pause') {
        if (!['true', 'false'].includes(value)) addIssue(line, 'invalidBoolean', 'pause 只能是 true 或 false。')
        else current.fields.autoStart = value === 'false'
      } else {
        const header = name === 'header' ? value : `${name === 'referer' ? 'Referer' : 'User-Agent'}: ${value}`
        const colon = header.indexOf(':')
        const headerName = header.slice(0, colon)
        const headerValue = header.slice(colon + 1).trim()
        if (colon < 1 || !headerToken.test(headerName) || controls.test(header) || header.length > 8192 || !headerValue) {
          addIssue(line, 'invalidHeader', '请求头必须是 Name: value，不能含控制字符或超过 8192 个字符。'); continue
        }
        if (forbiddenHeaders.has(headerName.toLowerCase())) {
          addIssue(line, 'reservedHeader', `请求头 ${headerName} 由下载引擎管理，不能在清单中覆盖。`); continue
        }
        const headers = current.fields.headers ??= []
        if (headers.length >= DOWNLOAD_IMPORT_LIMITS.headers || headers.some(item => item.slice(0, item.indexOf(':')).toLowerCase() === headerName.toLowerCase())) {
          addIssue(line, 'duplicateHeader', '请求头不能重名，每个任务最多 32 个请求头。'); continue
        }
        headers.push(`${headerName}: ${headerValue}`)
      }
      continue
    }
    if (optionAssignment.test(trimmed)) { globalIssue(line, 'missingIndent', '任务选项必须以空格或制表符缩进。'); continue }
    if (entries.length >= DOWNLOAD_IMPORT_LIMITS.tasks) { globalIssue(line, 'tooManyTasks', '一次最多导入 500 个任务。'); break }
    // The upstream parser deliberately separates mirror URIs only on tabs.
    const uris = rawLine.split('\t').map(part => part.trim()).filter(Boolean)
    current = { id: `line-${line}`, line, uris: [], options: [], fields: {}, issues: [] }
    entries.push(current)
    if (uris.length > DOWNLOAD_IMPORT_LIMITS.mirrors) addIssue(line, 'tooManyMirrors', '每个任务最多 32 个地址（含首选地址）。')
    for (const uri of uris) {
      const normalized = normalizeURI(uri)
      if (!normalized) addIssue(line, 'unsupportedURI', '地址必须是有效的 HTTP、HTTPS、FTP 或可解码的迅雷链接；同一任务的镜像用制表符分隔。')
      else if (!current.uris.includes(normalized)) current.uris.push(normalized)
    }
    if (!current.uris.length) addIssue(line, 'emptyTask', '任务缺少可用地址。')
  }
  for (const entry of entries) {
    if (entry.uris.length > 1 && entry.uris.some(uri => !/^https?:/i.test(uri))) {
      entry.issues.push({ line: entry.line, code: 'unsupportedMirrors', message: '多镜像任务目前只支持 HTTP 和 HTTPS。' })
    }
    if (entry.fields.headers?.length && entry.uris.some(uri => !/^https?:/i.test(uri))) {
      entry.issues.push({ line: entry.options.find(option => ['header', 'referer', 'user-agent'].includes(option.name))!.line, code: 'unsupportedHeaders', message: '请求头只适用于 HTTP 和 HTTPS，不能忽略后应用到 FTP。' })
    }
    const parsedURIs = entry.uris.map(uri => new URL(uri))
    if ((entry.fields.headers?.some(header => /^(authorization|cookie|referer|origin):/i.test(header))
        || parsedURIs.some(uri => uri.username || uri.password)) && new Set(parsedURIs.map(uri => uri.origin)).size > 1) {
      entry.issues.push({ line: entry.line, code: 'credentialMirrorOrigin', message: '含登录信息、Cookie、Authorization、Referer 或 Origin 的任务只能使用同源镜像。' })
    }
    if (entry.uris.length > 1 && parsedURIs.some(uri => /\.m3u8$/i.test(uri.pathname))) {
      entry.issues.push({ line: entry.line, code: 'unsupportedMediaMirrors', message: 'HLS 媒体清单暂不支持镜像切换，请保留一个地址。' })
    }
  }
  if (!entries.length && !issues.length) globalIssue(1, 'empty', '清单中没有下载地址。')
  return { entries, issues }
}
