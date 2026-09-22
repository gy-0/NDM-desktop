export interface SupportPreview { token: string; text: string }
export type SupportReply = { ok: true; preview?: SupportPreview; saved?: boolean; canceled?: boolean } | { ok: false; error: string }

const version = (value: unknown): string => typeof value === 'string' && /^\d{1,12}(?:\.\d{1,8}){0,3}(?:-[a-z]+\d*)?$/.test(value) ? value : '未确认'
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '未确认'

/** Construct an allowlisted report. Never stringify raw engine objects or errors. */
export function buildSupportReport(runtime: { version: unknown; build: unknown; platform: unknown; arch: unknown; release: unknown }, taskReply: unknown, bridgeReply: unknown): string {
  const platform = runtime.platform === 'darwin' ? 'macOS' : runtime.platform === 'win32' ? 'Windows' : '其他'
  const arch = ['arm64', 'x64', 'ia32'].includes(String(runtime.arch)) ? String(runtime.arch) : '未确认'
  const tasks = record(taskReply)
  const bridge = record(record(bridgeReply).bridge)
  const rows = [
    'NDM 支持诊断 · 格式 1',
    `应用版本：${version(runtime.version)}`, `构建：${version(runtime.build)}`,
    `系统：${platform} / ${arch} / 内核 ${version(runtime.release)}`,
    `下载引擎：${tasks.ok === true && Array.isArray(tasks.tasks) ? '已响应' : '暂不可用'}`
  ]
  if (tasks.ok === true && Array.isArray(tasks.tasks)) {
    const statuses = tasks.tasks.map(task => record(task).status)
    rows.push(`任务总数：${statuses.length}`)
    for (const [status, label] of [['complete', '已完成'], ['downloading', '下载中'], ['paused', '已暂停'], ['error', '失败'], ['waiting', '等待中'], ['incomplete', '未完成']]) {
      rows.push(`${label}：${statuses.filter(value => value === status).length}`)
    }
  }
  rows.push(`浏览器桥接：${bridge.available === true ? '已就绪' : bridge.available === false ? '未就绪' : '暂不可用'}`)
  if (typeof bridge.available === 'boolean') {
    rows.push(`浏览器连接数：${count(bridge.connectedClients)}`, `要求扩展版本：${version(bridge.expectedRelayVersion)}`)
    const versions = Array.isArray(bridge.relayClients) ? [...new Set(bridge.relayClients.filter(client => record(client).role === 'worker').map(client => version(record(client).version)))].slice(0, 10) : []
    rows.push(`已连接扩展版本：${versions.length ? versions.join('、') : '未确认'}`)
  }
  rows.push('', '不含下载地址、文件名、保存路径、浏览器资料、Cookie、代理或登录信息。', '不会自动上传。反馈时请另行描述操作步骤、预期结果和实际结果。')
  return rows.join('\n') + '\n'
}
