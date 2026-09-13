import { useEffect, useRef, useState } from 'react'
import { Check, FileUp, LoaderCircle } from 'lucide-react'
import type { DownloadImportCreateReply, DownloadImportPreview, DownloadImportPreviewReply, DownloadImportResult, DownloadImportStatusReply } from '../../../shared/downloadImport'

const buttonClass = 'rounded-control border border-line px-3 py-2 text-[12px] text-paper transition-colors hover:bg-line disabled:opacity-40'

/** Embedded in Composer; deliberately contains no nested form. */
export function DownloadImportPanel({ onCreated }: { onCreated?: (taskID: number) => void } = {}) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<DownloadImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<Record<string, DownloadImportResult>>({})
  const [autoStart, setAutoStart] = useState(true)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeID, setActiveID] = useState<string | null>(null)
  const working = useRef(true)
  const mounted = useRef(true)
  const [recovered, setRecovered] = useState(false)

  const acceptSnapshot = (reply: DownloadImportStatusReply) => {
    if (!reply?.ok) throw new Error('没有收到有效的导入恢复结果。')
    if (reply.session) {
      const { preview: restored, input, results: savedResults, autoStart: savedAutoStart } = reply.session
      setPreview(restored); setText(input)
      const byID = Object.fromEntries(savedResults.map(result => [result.id, result]))
      setResults(byID)
      setSelected(new Set(restored.entries.filter(entry => !entry.issues.length && byID[entry.id]?.status !== 'accepted').map(entry => entry.id)))
      setAutoStart(savedAutoStart ?? true)
      setRecovered(true)
    }
    setError(reply.warning ?? null)
  }

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    working.current = true; setBusy(true)
    void (async () => {
      try {
        if (!window.ndm) throw new Error('下载服务尚未连接。')
        const reply = await window.ndm.request('downloadImportResume') as DownloadImportStatusReply
        if (!cancelled) acceptSnapshot(reply)
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : '暂时无法恢复导入清单，原记录已保留。')
      } finally { if (!cancelled) { working.current = false; setBusy(false) } }
    })()
    return () => { cancelled = true; mounted.current = false }
  }, [])

  const resume = async () => {
    if (working.current) return
    working.current = true; setBusy(true); setError(null)
    try {
      if (!window.ndm) throw new Error('下载服务尚未连接。')
      const reply = await window.ndm.request('downloadImportResume') as DownloadImportStatusReply
      if (mounted.current) acceptSnapshot(reply)
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '暂时无法核对导入结果。') }
    finally { working.current = false; if (mounted.current) setBusy(false) }
  }
  const attempted = Object.keys(results).length > 0
  const uncertain = Object.values(results).some(result => result.status === 'unconfirmed')
  const candidates = preview?.entries.filter(entry => !entry.issues.length && results[entry.id]?.status !== 'accepted') ?? []
  const accepted = Object.values(results).filter(result => result.status === 'accepted').length

  const load = async (source: 'file' | 'text') => {
    if (working.current) return
    working.current = true; setBusy(true); setError(null)
    try {
      if (!window.ndm) throw new Error('下载服务尚未连接。')
      const reply = await window.ndm.request('downloadImportPreview', source === 'file' ? { source } : { source, text }) as DownloadImportPreviewReply
      if (!mounted.current || 'cancelled' in reply) return
      if (!reply.ok || !Array.isArray(reply.entries)) throw new Error('没有收到有效的导入预览。')
      setPreview(reply); setResults({}); setAutoStart(true); setRecovered(false)
      setSelected(new Set(reply.entries.filter(entry => !entry.issues.length).map(entry => entry.id)))
      const status = await window.ndm.request('downloadImportStatus') as DownloadImportStatusReply
      if (mounted.current && status.session?.preview.sessionID === reply.sessionID) setText(status.session.input)
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '无法读取任务清单。') }
    finally { working.current = false; if (mounted.current) setBusy(false) }
  }

  const createSelected = async () => {
    if (working.current || !preview) return
    working.current = true; setBusy(true); setError(null)
    try {
      if (!window.ndm) throw new Error('下载服务尚未连接。')
      // One request per row exposes each ACK immediately and bounds a lost reply.
      for (const entry of candidates.filter(entry => selected.has(entry.id))) {
        if (!mounted.current) break
        setActiveID(entry.id)
        let result: DownloadImportResult
        try {
          const reply = await window.ndm.request('downloadImportCreate', { sessionID: preview.sessionID, itemIDs: [entry.id], autoStart }) as DownloadImportCreateReply
          const acknowledged = reply?.ok === true ? reply.results?.find(result => result.id === entry.id) : undefined
          if (!acknowledged) throw new Error('尚未收到这一项的创建确认。')
          result = acknowledged
        } catch (error) {
          result = { id: entry.id, status: 'unconfirmed', error: error instanceof Error ? error.message : '创建结果未确认，请重试。' }
        }
        if (!mounted.current) break
        setResults(previous => ({ ...previous, [entry.id]: result }))
        if (result.status === 'accepted' && result.taskID) onCreated?.(result.taskID)
      }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '无法创建下载任务。') }
    finally { working.current = false; if (mounted.current) { setActiveID(null); setBusy(false) } }
  }

  return <section aria-label="导入任务清单" className="mt-3 rounded-xl border border-line bg-panel/40 p-3.5">
    {!preview ? <>
      <p className="mb-3 text-[12px] leading-relaxed text-mist">选择 aria2 任务文件，或粘贴清单。每行一个任务，同一行的镜像地址用制表符分隔，任务选项在下一行缩进。</p>
      <textarea aria-label="aria2 任务清单" value={text} onChange={event => setText(event.target.value)} disabled={busy} rows={5} maxLength={1_048_576} spellCheck={false} placeholder={'https://example.com/file.zip\n  out=file.zip\n  pause=true'} className="w-full resize-y rounded-control border border-line bg-ink/40 p-3 font-mono text-[12px] text-paper outline-none focus:border-copper/50 disabled:opacity-40" />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void load('file')} disabled={busy} className={`${buttonClass} inline-flex items-center gap-1.5`}><FileUp size={14} aria-hidden />选择任务文件</button>
        <button type="button" onClick={() => void load('text')} disabled={busy || !text.trim()} className={buttonClass}>{busy ? '正在读取…' : '预览粘贴内容'}</button>
        <button type="button" onClick={() => void resume()} disabled={busy} className={buttonClass}>恢复上次清单</button>
      </div>
      <p className="mt-2 text-[11px] text-mist">预览后会安全保存清单和创建记录；尚未预览的文本仍保留在当前输入框。</p>
    </> : <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0"><p className="truncate text-[13px] font-medium text-paper">{preview.sourceName}</p><p role="status" className="mt-1 text-[12px] text-mist">{preview.entries.length} 个任务 · 已创建 {accepted} 个</p></div>
        <button type="button" disabled={busy || uncertain} className={buttonClass} onClick={() => { if (accepted === preview.entries.length) setText(''); setPreview(null); setResults({}); setError(null); setRecovered(false) }}>{accepted ? '开始新清单' : '修改清单'}</button>
      </div>
      {recovered ? <p role="status" className="mt-2 text-[12px] text-mist">已恢复上次清单并核对创建回执；恢复过程不会提交新任务。</p> : null}
      {preview.entries.some(entry => entry.uris.length > 1) ? <p className="mt-2 text-[12px] leading-relaxed text-mist">镜像会在下载尚未写入数据时自动切换；已有续传数据时保留当前来源，重新下载后再尝试全部镜像。</p> : null}
      {preview.issues.length ? <ul role="alert" className="mt-3 space-y-1 text-[12px] text-clay">{preview.issues.map((issue, index) => <li key={index}>第 {issue.line} 行：{issue.message}</li>)}</ul> : null}
      <div className="my-3 flex items-center justify-between gap-2 text-[12px] text-mist">
        <label className="flex items-center gap-2"><input type="checkbox" aria-label="选择全部可创建任务" disabled={busy || !candidates.length} checked={candidates.length > 0 && candidates.every(entry => selected.has(entry.id))} onChange={event => setSelected(event.target.checked ? new Set(candidates.map(entry => entry.id)) : new Set())} />选择可创建任务</label>
        <span>带错误的任务不会创建</span>
      </div>
      <ol className="max-h-[300px] divide-y divide-line overflow-y-auto rounded-control border border-line">
        {preview.entries.map(entry => {
          const result = results[entry.id]
          const done = result?.status === 'accepted'
          return <li key={entry.id} data-import-item={entry.id} className="p-3">
            <div className="flex items-start gap-2.5">
              <input type="checkbox" aria-label={`选择第 ${entry.line} 行任务`} checked={done || selected.has(entry.id)} disabled={busy || done || !!entry.issues.length} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(entry.id); else next.delete(entry.id); return next })} className="mt-1" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><p className="truncate text-[13px] text-paper">{entry.fields.filename || entry.uris[0] || `第 ${entry.line} 行任务`}</p>{done ? <Check size={14} className="shrink-0 text-copper" aria-label="已创建" /> : activeID === entry.id ? <LoaderCircle size={14} className="shrink-0 animate-spin motion-reduce:animate-none" aria-label="正在确认" /> : null}</div>
                <p className="mt-1 text-[11px] text-mist">第 {entry.line} 行 · {entry.uris.length} 个地址 · {entry.options.length} 个选项{done ? ` · 任务 #${result.taskID}` : ''}</p>
                <details className="mt-2 text-[12px] text-mist"><summary className="cursor-pointer">查看地址、镜像和选项</summary><ul className="mt-2 space-y-1 break-all font-mono">{entry.uris.map((uri, index) => <li key={index}>{index ? `镜像 ${index}：` : '首选：'}{uri}</li>)}</ul>{entry.options.length ? <dl className="mt-2 space-y-1 break-all font-mono">{entry.options.map((option, index) => <div key={index}><dt className="inline">{option.name}=</dt><dd className="inline">{option.value}</dd></div>)}</dl> : null}</details>
                {entry.issues.map((issue, index) => <p key={index} className="mt-1 text-[12px] text-clay">第 {issue.line} 行：{issue.message}</p>)}
                {result?.error ? <p role="status" className="mt-2 text-[12px] text-clay">{result.error}</p> : null}
              </div>
            </div>
          </li>
        })}
      </ol>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[12px] text-mist"><input type="checkbox" checked={autoStart} onChange={event => setAutoStart(event.target.checked)} disabled={busy || attempted} />创建后开始下载（以每项 pause 选项为准）</label>
        <button type="button" onClick={() => void createSelected()} disabled={busy || !!preview.issues.length || !candidates.some(entry => selected.has(entry.id))} className={`${buttonClass} border-copper/30 bg-copper/10`}>{busy ? '逐项确认中…' : attempted ? '核对并重试所选任务' : `确认创建 ${candidates.filter(entry => selected.has(entry.id)).length} 个任务`}</button>
      </div>
      {uncertain ? <div className="mt-2 space-y-2"><p className="text-[12px] text-mist">部分结果尚未确认。原清单已保存，恢复时会核对已记录的创建操作。已创建的任务会保留。</p><button type="button" onClick={() => void resume()} disabled={busy} className={buttonClass}>仅核对回执</button></div> : null}
    </>}
    {error ? <p role="alert" className="mt-3 text-[12px] text-clay">{error}</p> : null}
  </section>
}
