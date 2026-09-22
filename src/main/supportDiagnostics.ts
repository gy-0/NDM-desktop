import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildSupportReport, type SupportPreview, type SupportReply } from '../shared/supportDiagnostics'

interface Dependencies {
  runtime: Parameters<typeof buildSupportReport>[0]
  request: (op: string) => Promise<unknown>
  chooseExportPath: () => Promise<string | null>
  writeText?: (path: string, text: string) => Promise<void>
  now?: () => number
  timeoutMs?: number
}

async function writeReport(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.ndm-support-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(text, 'utf8'); await file.sync(); await file.close()
    await rename(temporary, path)
  } finally {
    await file.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

export class SupportDiagnosticsService {
  private preview: (SupportPreview & { expires: number }) | null = null
  private working = false
  constructor(private readonly dependencies: Dependencies) {}
  private async read(op: string): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.dependencies.request(op),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), this.dependencies.timeoutMs ?? 4000) })
      ])
    } catch { return null }
    finally { clearTimeout(timer) }
  }
  async request(op: string, extra: Record<string, unknown> = {}): Promise<SupportReply> {
    if (this.working) return { ok: false, error: '正在处理诊断，请稍后再试。' }
    this.working = true
    try {
      if (op === 'supportDiagnosticsPreview') {
        const [tasks, bridge] = await Promise.all([this.read('list'), this.read('getBridgeStatus')])
        const text = buildSupportReport(this.dependencies.runtime, tasks, bridge)
        this.preview = { token: randomUUID(), text, expires: (this.dependencies.now?.() ?? Date.now()) + 10 * 60 * 1000 }
        return { ok: true, preview: { token: this.preview.token, text } }
      }
      if (op !== 'supportDiagnosticsExport') return { ok: false, error: '不支持的诊断操作。' }
      const preview = this.preview
      if (!preview || preview.token !== extra.token || preview.expires <= (this.dependencies.now?.() ?? Date.now())) {
        return { ok: false, error: '诊断预览已过期，请重新生成后导出。' }
      }
      const path = await this.dependencies.chooseExportPath()
      if (!path) return { ok: true, canceled: true }
      // Export precisely the main-process preview, never renderer-supplied text.
      await (this.dependencies.writeText ?? writeReport)(path, preview.text)
      return { ok: true, saved: true }
    } catch { return { ok: false, error: '未能保存诊断，请检查保存位置的权限后重试。' } }
    finally { this.working = false }
  }
}
