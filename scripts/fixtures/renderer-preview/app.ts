import type { ComposerDraft } from '../../../src/shared/composerDraft'
import type { MediaFormat } from '../../../src/renderer/src/lib/types'

const params = new URLSearchParams(location.search)
const defaultURL = 'https://www.youtube.com/watch?v=jfKfPfyJRdk'
const title = params.get('title') || 'A quiet place to begin — cinematic moments in Japan | 4K'
const subtitleMode = params.get('subtitles') || 'none'
const probeMode = params.get('probe') || 'success'
const draftKey = 'ndm.qa.composer-draft'
const eventListeners = new Set<(message: Record<string, unknown>) => void>()
const menuListeners = new Set<(action: string) => void>()
const log: { probes: unknown[]; storage: unknown[]; creations: unknown[]; drafts: unknown[]; unsupported: string[] } = {
  probes: [], storage: [], creations: [], drafts: [], unsupported: []
}
const mib = 1024 * 1024
const formats: MediaFormat[] = [
  { id: '2160', label: '4K · 2160p', height: 2160, approximateBytes: 820 * mib, componentBytes: [800 * mib, 20 * mib], compactApproximateBytes: 610 * mib, compactComponentBytes: [590 * mib, 20 * mib], containerHint: 'MP4', isVideo: true },
  { id: '1440', label: '2K · 1440p', height: 1440, approximateBytes: 450 * mib, componentBytes: [430 * mib, 20 * mib], compactApproximateBytes: 340 * mib, compactComponentBytes: [320 * mib, 20 * mib], containerHint: 'MP4', isVideo: true },
  { id: '1080', label: '1080p', height: 1080, approximateBytes: 224 * mib, componentBytes: [204 * mib, 20 * mib], compactApproximateBytes: 156 * mib, compactComponentBytes: [136 * mib, 20 * mib], containerHint: 'MP4', isVideo: true },
  { id: '720', label: '720p', height: 720, approximateBytes: 112 * mib, componentBytes: [92 * mib, 20 * mib], compactApproximateBytes: 90 * mib, compactComponentBytes: [70 * mib, 20 * mib], containerHint: 'MP4', isVideo: true },
  { id: '480', label: '480p', height: 480, approximateBytes: 64 * mib, componentBytes: [44 * mib, 20 * mib], compactApproximateBytes: 48 * mib, compactComponentBytes: [28 * mib, 20 * mib], containerHint: 'MP4', isVideo: true },
  { id: 'audio', label: '仅音频', height: 0, approximateBytes: 20 * mib, componentBytes: [20 * mib], compactApproximateBytes: 20 * mib, compactComponentBytes: [20 * mib], containerHint: 'M4A', isVideo: false }
]
// Opt-in overflow fixture: keep the original six-option preview unchanged.
if (params.get('formats') === 'extended') {
  formats.unshift({ id: '4320', label: '8K · 4320p', height: 4320, approximateBytes: 1640 * mib, componentBytes: [1620 * mib, 20 * mib], compactApproximateBytes: 1220 * mib, compactComponentBytes: [1200 * mib, 20 * mib], containerHint: 'MP4', isVideo: true })
  formats.splice(formats.length - 1, 0, ...[360, 240, 144].map((height, index) => ({
    id: String(height), label: `${height}p`, height, approximateBytes: (40 - index * 10) * mib,
    componentBytes: [(30 - index * 10) * mib, 10 * mib], compactApproximateBytes: (32 - index * 8) * mib,
    compactComponentBytes: [(24 - index * 8) * mib, 8 * mib], containerHint: 'MP4', isVideo: true
  })))
}
const settings = { downloadDirectory: '/Users/demo/Downloads', maxConnections: 16, bandwidthLimitBytesPerSecond: 0, useCategoryFolders: false, downloadAllAtOnce: true, smartConnections: true, bridgePort: 52525 }
let tasks: Record<string, unknown>[] = params.get('tasks') === 'empty' ? [] : [
  { id: 41, filename: 'Design systems handbook.pdf', title: 'Design systems handbook.pdf', url: 'https://example.test/design.pdf', category: 'document', status: 'complete', fileSize: 18 * mib, completedBytes: 18 * mib, folderPath: settings.downloadDirectory, connections: 16, segments: [] },
  { id: 42, filename: 'Project archive.zip', title: 'Project archive.zip', url: 'https://example.test/archive.zip', category: 'compressed', status: 'paused', fileSize: 724 * mib, completedBytes: 220 * mib, folderPath: settings.downloadDirectory, connections: 16, segments: [] }
]
let draft: { revision: number; draft: ComposerDraft | null } = { revision: 0, draft: null }
try { const saved = localStorage.getItem(draftKey); if (saved) draft = JSON.parse(saved) } catch { /* fresh QA profile */ }
localStorage.setItem('ndm.onboarded', '1')
function publish() { window.parent.postMessage({ type: 'ndm-qa-log', state: log }, location.origin) }
function emit(message: Record<string, unknown>) { for (const listener of eventListeners) listener(message) }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
async function request(op: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  if (op === 'list') return { ok: true, tasks: clone(tasks) }
  if (op === 'getSettings') return { ok: true, settings }
  if (op === 'updateSettings') return { ok: true, settings: Object.assign(settings, extra) }
  if (op === 'temporaryBandwidthStatus') return { status: 'inactive', limitBytesPerSecond: null, previousLimitBytesPerSecond: null, expiresAt: null }
  if (op === 'findDuplicate') return { ok: true, task: null }
  if (op === 'composerDraftFlushResult') return { ok: true }
  if (op.startsWith('composerDraft')) {
    if (op !== 'composerDraftLoad') {
      if (extra.expectedRevision !== draft.revision) return { ok: false, code: 'conflict', error: 'QA 草稿版本冲突', revision: draft.revision }
      draft = { revision: draft.revision + 1, draft: op === 'composerDraftDiscard' ? null : clone(extra.draft as ComposerDraft) }
      localStorage.setItem(draftKey, JSON.stringify(draft))
    }
    log.drafts.push({ op, revision: draft.revision, itemCount: draft.draft?.items.length ?? 0 }); publish()
    return { ok: true, ...clone(draft) }
  }
  if (op === 'probeMedia') {
    log.probes.push(clone(extra)); publish()
    await new Promise(resolve => setTimeout(resolve, 280))
    if (probeMode === 'fail' || (probeMode === 'recover' && log.probes.length === 1)) return { ok: false, errorKind: 'probeFailed', error: 'QA：本次媒体解析失败，请重试。' }
    if (probeMode === 'session' && !extra.cookieBrowser) return { ok: false, errorKind: 'browserSessionRequired' }
    return { ok: true, title, duration: 632, formats, subtitles: subtitleMode === 'available' ? [
      { code: 'en', displayName: 'English', isAutomatic: false }, { code: 'zh-Hans', displayName: '简体中文', isAutomatic: false }, { code: 'ja', displayName: '日本語', isAutomatic: true }
    ] : [] }
  }
  if (op === 'checkStorage') {
    log.storage.push(clone(extra)); publish()
    const finalBytes = Number(extra.finalBytes || 820 * mib), peakBytes = finalBytes * 2 + 128 * mib
    const level = params.get('storage') || 'comfortable'
    const availableBytes = level === 'insufficient' ? 500 * mib : level === 'tight' ? peakBytes + 300 * mib : 136_000 * mib
    return { ok: true, level, peakBytes, finalBytes, availableBytes, projectedFreeBytes: Math.max(0, availableBytes - finalBytes), shortfallBytes: Math.max(0, peakBytes - availableBytes), isCollectionEstimate: false }
  }
  if (op === 'addMedia' || op === 'add') {
    const task = { id: 100 + log.creations.length, filename: extra.filename || `${title}.${extra.container === 'compactMKV' ? 'mkv' : 'mp4'}`, title, url: extra.url, pageURL: extra.url, category: op === 'addMedia' ? 'video' : 'misc', status: 'paused', fileSize: formats.find(format => format.id === extra.formatID)?.approximateBytes ?? 0, completedBytes: 0, folderPath: extra.folderPath || settings.downloadDirectory, connections: extra.connections || 16, segments: [], mediaOptions: { container: extra.container, subtitleLanguage: extra.subtitleLanguage } }
    log.creations.push({ op, options: clone(extra), taskID: task.id }); tasks = [task, ...tasks]; publish()
    setTimeout(() => emit({ op: 'snapshot', tasks: clone(tasks) }), 0)
    return { ok: true, task: clone(task) }
  }
  if (op === 'getCreationReceipt') return { ok: true, found: false }
  if (op === 'pause' || op === 'resume') {
    tasks = tasks.map(task => task.id === extra.taskID ? { ...task, status: op === 'pause' ? 'paused' : 'downloading' } : task)
    emit({ op: 'snapshot', tasks: clone(tasks) }); return { ok: true }
  }
  if (!log.unsupported.includes(op)) log.unsupported.push(op)
  publish()
  return { ok: false, error: `QA fixture does not implement ${op}` }
}
window.ndm = {
  getWindowChrome: async () => ({ fullScreen: Boolean(document.fullscreenElement) }),
  getWindowZoomFactor: () => 1,
  onWindowChromeChanged: listener => { const update = () => listener({ fullScreen: Boolean(document.fullscreenElement) }); document.addEventListener('fullscreenchange', update); return () => document.removeEventListener('fullscreenchange', update) },
  platform: params.get('platform') || 'darwin', version: '2026.9.12', build: 'renderer-qa',
  status: async () => 'live', request, getEngineError: async () => null, retryEngine: async () => ({ status: 'live' }),
  selectFolder: async () => '/Users/demo/Downloads/QA selected folder', revealFile: async () => true, installDiskImage: async () => '', openPath: async () => '', shareFile: async () => true, quickLook: async () => true, openExternal: async () => true,
  readClipboard: async () => '', readClipboardSnapshot: async () => ({ text: '', changeCount: 0, selfWritten: false }), writeClipboard: async () => {},
  classifyURL: async () => ({ kind: 'html', contentType: 'text/html', disposition: null, contentLength: null }),
  loadThumbnail: async () => null, loadFileThumbnail: async () => null,
  onEvent: listener => { eventListeners.add(listener); return () => eventListeners.delete(listener) },
  onStatus: () => () => {}, onMenuAction: listener => { menuListeners.add(listener); return () => menuListeners.delete(listener) },
  notifySnapshot: () => {}, setWindowTheme: () => {}
}
if (params.get('traffic') !== '0' && window.ndm.platform === 'darwin') {
  const lights = document.createElement('div')
  lights.setAttribute('aria-label', '模拟 macOS 红绿灯，原点 16,18，非原生控件')
  lights.style.cssText = 'position:fixed;left:16px;top:18px;display:flex;gap:8px;z-index:9999;pointer-events:none'
  for (const color of ['#ff5f57', '#febc2e', '#28c840']) { const dot = document.createElement('i'); dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};box-shadow:inset 0 0 0 1px #0001`; lights.append(dot) }
  document.body.append(lights)
}
// Install the bridge before imports evaluate platform constants.
await import('../../../src/renderer/src/main')
publish()
if ((params.get('view') || 'composer') === 'composer') {
  const open = () => {
    if (eventListeners.size < 2) { setTimeout(open, 30); return }
    emit({ op: 'openMediaComposer', url: params.get('url') || defaultURL })
  }
  setTimeout(open, 100)
}
