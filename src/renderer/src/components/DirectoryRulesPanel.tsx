import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, FolderOpen, Plus, Trash2 } from 'lucide-react'
import {
  DIRECTORY_RULE_LIMITS, isDirectoryForPlatform, type DirectoryRule, type DirectoryRuleResolution, type DirectoryRulesConfig, type DirectoryRulesReply
} from '../../../shared/directoryRules'

type RuleDraft = Omit<DirectoryRule, 'hosts' | 'pathGlobs' | 'extensions'> & { hostsText: string; pathsText: string; extensionsText: string }
const toDraft = (rule: DirectoryRule): RuleDraft => ({ ...rule, hostsText: rule.hosts.join('\n'), pathsText: rule.pathGlobs.join('\n'), extensionsText: rule.extensions.join(', ') })
const lines = (value: string) => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
const toRule = ({ hostsText, pathsText, extensionsText, ...rule }: RuleDraft): DirectoryRule => ({ ...rule, hosts: lines(hostsText), pathGlobs: pathsText.split('\n').map(value => value.trim()).filter(Boolean), extensions: lines(extensionsText) })
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-control border border-line-strong px-2.5 py-1.5 text-meta text-fog hover:bg-line disabled:opacity-40'
const inputClass = 'w-full rounded-control border border-line bg-ink/40 px-2.5 py-2 text-meta text-paper outline-none focus:border-copper/50 disabled:opacity-40'

export function DirectoryRulesPanel({ onApplied }: { onApplied?: () => void | Promise<void> } = {}) {
  const [rules, setRules] = useState<RuleDraft[]>([])
  const [enabled, setEnabled] = useState(false)
  const [revision, setRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState(false)
  const [sampleURL, setSampleURL] = useState('')
  const [sampleFilename, setSampleFilename] = useState('')
  const [explicitDirectory, setExplicitDirectory] = useState('')
  const [resolution, setResolution] = useState<DirectoryRuleResolution | null>(null)
  const working = useRef(true), mounted = useRef(true)
  const config = (): DirectoryRulesConfig => ({ version: 1, enabled, rules: rules.map(toRule) })
  const edited = () => { setDirty(true); setResolution(null); setMessage('') }
  const request = async (op: string, extra: Record<string, unknown> = {}): Promise<DirectoryRulesReply> => {
    if (!window.ndm) throw new Error('下载服务尚未连接。')
    const reply = await window.ndm.request(op, extra) as DirectoryRulesReply
    if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.error : '没有收到有效的目录规则结果。')
    return reply
  }
  const acceptConfig = (reply: DirectoryRulesReply) => {
    if (!reply.ok || !('config' in reply)) throw new Error('未能读取目录规则。')
    setRules(reply.config.rules.map(toDraft)); setEnabled(reply.config.enabled); setRevision(reply.revision)
    setDirty(false); setResolution(null)
  }
  useEffect(() => {
    let cancelled = false
    mounted.current = true
    working.current = true
    void request('directoryRulesGet').then(reply => { if (!cancelled) acceptConfig(reply) }).catch(error => {
      if (!cancelled) { setFailure(true); setMessage(error instanceof Error ? error.message : '无法读取目录规则。') }
    }).finally(() => { if (!cancelled) { working.current = false; setBusy(false) } })
    return () => { cancelled = true; mounted.current = false }
  }, [])

  const run = async (action: () => Promise<void>) => {
    if (working.current) return
    working.current = true; setBusy(true); setMessage(''); setFailure(false)
    try { await action() }
    catch (error) { if (mounted.current) { setFailure(true); setMessage(error instanceof Error ? error.message : '目录规则操作未完成，当前编辑内容仍保留。') } }
    finally { working.current = false; if (mounted.current) setBusy(false) }
  }
  const change = (id: string, patch: Partial<RuleDraft>) => { setRules(previous => previous.map(rule => rule.id === id ? { ...rule, ...patch } : rule)); edited() }
  const move = (index: number, delta: number) => {
    setRules(previous => { const next = [...previous]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next }); edited()
  }
  const chooseDirectory = async (): Promise<string | null> => {
    const reply = await request('directoryRulesChooseDirectory')
    if (!reply.ok || !('directory' in reply)) throw new Error('未能选择目录。')
    return reply.directory
  }

  return <section aria-label="下载目录规则" className="space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div><h3 className="text-body font-medium text-paper">下载目录规则</h3><p className="mt-1 text-meta leading-relaxed text-mist">按顺序使用第一条匹配规则。手动选定的目录优先；未匹配时沿用默认目录和分类设置。</p></div>
      <label className="flex shrink-0 items-center gap-2 text-meta text-fog"><input type="checkbox" aria-label="启用下载目录规则" checked={enabled} disabled={busy || revision === null} onChange={event => { setEnabled(event.target.checked); edited() }} />启用</label>
    </div>
    <p className="text-caption leading-relaxed text-mist">每组条件满足任意一项，填写多组时须同时满足。主机不区分大小写；URL 路径使用地址中的编码形式，区分大小写，不含查询参数。* 匹配任意字符串，? 匹配一个字符。扩展名只匹配最后一段，无扩展名不匹配扩展名条件。</p>
    {!rules.length ? <p className="rounded-control border border-dashed border-line-strong p-3 text-meta text-mist">尚无规则。添加规则并保存后，仅影响新建任务的目标目录。</p> : null}
    <ol className="space-y-3">{rules.map((rule, index) => <li key={rule.id} className="space-y-2 rounded-control border border-line-strong p-3">
      <div className="flex items-center gap-2">
        <span className="text-caption text-mist">{index + 1}</span>
        <input type="checkbox" aria-label={`启用规则 ${index + 1}`} checked={rule.enabled} disabled={busy} onChange={event => change(rule.id, { enabled: event.target.checked })} />
        <input aria-label={`规则 ${index + 1} 名称`} value={rule.name} maxLength={80} disabled={busy} onChange={event => change(rule.id, { name: event.target.value })} className={`${inputClass} min-w-0 flex-1`} />
        <button type="button" aria-label={`上移规则 ${index + 1}`} disabled={busy || index === 0} className={buttonClass} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
        <button type="button" aria-label={`下移规则 ${index + 1}`} disabled={busy || index === rules.length - 1} className={buttonClass} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
        <button type="button" aria-label={`删除规则 ${index + 1}`} disabled={busy} className={buttonClass} onClick={() => { setRules(previous => previous.filter(value => value.id !== rule.id)); edited() }}><Trash2 size={13} /></button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-caption text-mist"><span>主机（逗号或换行分隔）</span><textarea aria-label={`规则 ${index + 1} 主机`} rows={2} maxLength={2048} value={rule.hostsText} disabled={busy} onChange={event => change(rule.id, { hostsText: event.target.value })} placeholder="*.example.com" className={`${inputClass} resize-y font-mono`} /></label>
        <label className="space-y-1 text-caption text-mist"><span>URL 路径（每行一项）</span><textarea aria-label={`规则 ${index + 1} 路径`} rows={2} maxLength={2048} value={rule.pathsText} disabled={busy} onChange={event => change(rule.id, { pathsText: event.target.value })} placeholder="/releases/*" className={`${inputClass} resize-y font-mono`} /></label>
        <label className="space-y-1 text-caption text-mist"><span>扩展名（逗号或换行分隔）</span><textarea aria-label={`规则 ${index + 1} 扩展名`} rows={2} maxLength={2048} value={rule.extensionsText} disabled={busy} onChange={event => change(rule.id, { extensionsText: event.target.value })} placeholder="zip, dmg" className={`${inputClass} resize-y font-mono`} /></label>
      </div>
      <div className="flex items-center gap-2"><p className="min-w-0 flex-1 break-all text-meta text-fog">{rule.directory}</p><button type="button" disabled={busy} className={buttonClass} onClick={() => void run(async () => { const directory = await chooseDirectory(); if (directory && mounted.current) change(rule.id, { directory }) })}><FolderOpen size={13} />更改目录</button></div>
      {!isDirectoryForPlatform(rule.directory, window.ndm?.platform === 'win32' ? 'win32' : 'posix') ? <p className="text-caption text-clay">此目录不适用于当前系统，匹配时会跳过这条规则。</p> : null}
    </li>)}</ol>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy || revision === null || rules.length >= DIRECTORY_RULE_LIMITS.rules} className={buttonClass} onClick={() => void run(async () => {
        const directory = await chooseDirectory()
        if (directory && mounted.current) { setRules(previous => [...previous, { id: crypto.randomUUID(), name: '新规则', enabled: true, directory, hostsText: '', pathsText: '', extensionsText: '' }]); edited() }
      })}><Plus size={13} />添加规则</button>
      <button type="button" disabled={busy || revision === null || !dirty} className={`${buttonClass} border-copper/30 bg-copper/10 text-paper`} onClick={() => void run(async () => {
        const reply = await request('directoryRulesSave', { expectedRevision: revision, config: config() })
        if (mounted.current) { acceptConfig(reply); setMessage('目录规则已保存，仅应用于新建任务。') }
        await Promise.resolve().then(() => onApplied?.()).catch(() => undefined)
      })}>保存规则</button>
      <button type="button" disabled={busy} className={buttonClass} onClick={() => void run(async () => { const reply = await request('directoryRulesGet'); if (mounted.current) acceptConfig(reply) })}>{dirty ? '放弃编辑并重新读取' : '重新读取'}</button>
    </div>
    <div className="space-y-2 rounded-control border border-line p-3">
      <p className="text-meta font-medium text-paper">预览当前编辑的规则</p>
      <input aria-label="规则预览地址" value={sampleURL} disabled={busy} maxLength={4096} onChange={event => { setSampleURL(event.target.value); setResolution(null) }} placeholder="https://example.com/file.zip" className={inputClass} />
      <input aria-label="规则预览文件名" value={sampleFilename} disabled={busy} maxLength={512} onChange={event => { setSampleFilename(event.target.value); setResolution(null) }} placeholder="可选：任务文件名（优先于地址的扩展名）" className={inputClass} />
      <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={busy} className={buttonClass} onClick={() => void run(async () => { const directory = await chooseDirectory(); if (directory && mounted.current) { setExplicitDirectory(directory); setResolution(null) } })}>模拟手动选择目录</button>{explicitDirectory ? <><span className="break-all text-caption text-mist">{explicitDirectory}</span><button type="button" disabled={busy} className={buttonClass} onClick={() => { setExplicitDirectory(''); setResolution(null) }}>清除</button></> : null}</div>
      <button type="button" disabled={busy || revision === null || !sampleURL.trim()} className={buttonClass} onClick={() => void run(async () => {
        const reply = await request('directoryRulesPreview', { config: config(), samples: [{ url: sampleURL, ...(sampleFilename ? { filename: sampleFilename } : {}), ...(explicitDirectory ? { explicitDirectory } : {}) }] })
        if (mounted.current && reply.ok && 'results' in reply) setResolution(reply.results[0] ?? null)
      })}>查看匹配结果</button>
      {resolution ? <div role="status" className="space-y-1 text-meta text-fog"><p>{resolution.source === 'explicit' ? '使用手动目录' : resolution.source === 'rule' ? `匹配规则：${resolution.ruleName}` : '使用现有默认目录 / 分类设置'}</p><p className="break-all text-paper">{resolution.directory}</p>{resolution.ignoredRuleIDs?.length ? <p className="text-caption text-mist">已跳过 {resolution.ignoredRuleIDs.length} 条目录不适用于当前系统的规则。</p> : null}</div> : null}
      <p className="text-caption text-mist">预览不会创建目录或下载任务，也不会保存样例地址。</p>
    </div>
    {busy ? <p role="status" className="text-meta text-mist">正在处理…</p> : null}
    {message ? <p role={failure ? 'alert' : 'status'} className={`text-meta leading-relaxed ${failure ? 'text-clay' : 'text-fog'}`}>{message}</p> : null}
  </section>
}
