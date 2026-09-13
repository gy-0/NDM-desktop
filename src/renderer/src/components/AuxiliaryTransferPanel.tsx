import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Pause, RefreshCw, Square } from 'lucide-react'
import {
  AUXILIARY_PHASE_LABELS, auxiliaryErrorMessage, auxiliarySelectionRequest, readAuxiliaryCapabilities, readAuxiliarySnapshot,
  type AuxiliaryCapabilities, type AuxiliarySnapshot
} from '../../../shared/auxiliaryTransfer'
import { formatBytes } from '../lib/format'

const control = 'inline-flex items-center justify-center gap-1.5 rounded-control border border-line px-2.5 py-2 text-[12px] text-paper hover:bg-raised disabled:opacity-40'

export function AuxiliaryTransferPanel({ taskID, onChanged }: { taskID: number; onChanged?: () => void | Promise<void> }) {
  const [snapshot, setSnapshot] = useState<AuxiliarySnapshot | null>(null)
  const [capabilities, setCapabilities] = useState<AuxiliaryCapabilities | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [selectionDirty, setSelectionDirty] = useState(false)
  const [autoStart, setAutoStart] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const generation = useRef(0), working = useRef(false), dirtyRef = useRef(false)
  const actionSequence = useRef(0)
  const currentSnapshot = useRef<AuxiliarySnapshot | null>(null)
  const scrollElement = useRef<HTMLDivElement>(null)
  const files = useMemo(() => snapshot?.files.filter(file => file.relativePath.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [], [snapshot?.files, search])
  const virtualizer = useVirtualizer({ count: files.length, getScrollElement: () => scrollElement.current, estimateSize: () => 64, overscan: 6 })
  const canSelect = !!snapshot && snapshot.kind === 'bittorrent' && ['paused', 'awaitingSelection'].includes(snapshot.phase) && capabilities?.fileSelection === true

  const fetchStatus = async (id: number): Promise<AuxiliarySnapshot> => {
    const reply = await window.ndm?.request('auxiliaryStatus', { taskID: id })
    const result = readAuxiliarySnapshot(reply, id)
    if (!result) throw new Error(auxiliaryErrorMessage(reply, '当前任务没有可用的辅助下载状态。'))
    return result
  }
  const accept = (next: AuxiliarySnapshot, reset = false) => {
    const previous = currentSnapshot.current
    const manifestChanged = !!previous && (previous.generation !== next.generation || previous.files.length !== next.files.length
      || previous.files.some((file, index) => file.index !== next.files[index].index || file.relativePath !== next.files[index].relativePath || file.length !== next.files[index].length))
    currentSnapshot.current = next
    setSnapshot(next)
    if (reset || !dirtyRef.current || manifestChanged) {
      setSelected(new Set(next.files.filter(file => file.selected).map(file => file.index)))
      dirtyRef.current = false; setSelectionDirty(false)
      if (manifestChanged && !reset) setError('文件清单已更新，请重新确认文件选择。')
    }
  }

  useEffect(() => {
    const current = ++generation.current
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    setSnapshot(null); currentSnapshot.current = null; setSelected(new Set()); setSearch(''); setSelectionDirty(false); dirtyRef.current = false
    setCapabilities(null); setLoading(true); setError(''); setBusy(false); working.current = false
    setUsername(''); setPassword('')
    const poll = async () => {
      if (working.current) { timer = setTimeout(() => void poll(), 1200); return }
      const sequence = actionSequence.current
      try {
        const next = await fetchStatus(taskID)
        if (stopped || generation.current !== current || sequence !== actionSequence.current) return
        accept(next)
      } catch (reason) {
        if (!stopped && generation.current === current) setError(reason instanceof Error ? reason.message : '暂时无法读取辅助下载状态。')
      } finally {
        if (!stopped && generation.current === current) { setLoading(false); timer = setTimeout(() => void poll(), 1500) }
      }
    }
    void window.ndm?.request('auxiliaryCapabilities').then(reply => { if (!stopped && generation.current === current) setCapabilities(readAuxiliaryCapabilities(reply)) }).catch(() => undefined)
    void poll()
    return () => { stopped = true; generation.current++; if (timer) clearTimeout(timer) }
  }, [taskID])

  const run = async (action: () => Promise<void>) => {
    if (working.current) return
    actionSequence.current++
    working.current = true; setBusy(true); setError('')
    const current = generation.current
    try { await action() }
    catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : '辅助下载操作未完成。') }
    finally { if (generation.current === current) { working.current = false; setBusy(false) } }
  }
  const refresh = async (current: number, reset = false) => {
    const next = await fetchStatus(taskID)
    if (generation.current === current) accept(next, reset)
  }
  const changed = () => Promise.resolve().then(() => onChanged?.()).catch(() => undefined)
  const selectedBytes = snapshot?.files.reduce((total, file) => total + (selected.has(file.index) ? file.length : 0), 0) ?? 0

  return <section aria-label="辅助协议任务" className="space-y-3 border-t border-line pt-4">
    <div className="flex items-center justify-between gap-2"><h3 className="text-[13px] font-medium text-paper">协议任务详情</h3><button type="button" className={control} disabled={busy || loading} onClick={() => void run(async () => { await refresh(generation.current) })}><RefreshCw size={13} />刷新状态</button></div>
    {loading ? <p role="status" className="text-[12px] text-mist">正在读取协议状态…</p> : null}
    {snapshot ? <>
      <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-[12px]"><span className={snapshot.phase === 'error' ? 'text-clay' : 'text-paper'}>{snapshot.kind === 'ed2k' && snapshot.phase === 'seeding' ? '正在共享' : AUXILIARY_PHASE_LABELS[snapshot.phase]}</span><span className="tabular-nums text-mist">{formatBytes(snapshot.completedBytes)} / {formatBytes(snapshot.totalBytes)}</span></div>
      {snapshot.phase === 'metadata' ? <p className="text-[12px] text-mist">正在获取文件清单，元数据完成后会暂停等待文件选择。</p> : null}
      {snapshot.phase === 'awaitingSelection' ? <p className="text-[12px] text-mist">至少选择一个文件并确认，才会开始下载文件内容。</p> : null}
      {snapshot.phase === 'error' || snapshot.errorCode ? <p className="text-[12px] text-clay">{auxiliaryErrorMessage({ code: snapshot.errorCode }, `下载未能完成${snapshot.errorCode ? `（错误码 ${snapshot.errorCode}）` : ''}。请检查任务来源和连接设置。`)}</p> : null}
      <div className="grid grid-cols-2 gap-2 text-[12px] text-mist"><span>下载 {formatBytes(snapshot.downloadSpeed)}/s</span><span>上传 {formatBytes(snapshot.uploadSpeed)}/s</span></div>
      {snapshot.kind === 'sftp' && ['paused', 'error'].includes(snapshot.phase) ? <div className="space-y-2 rounded-control border border-line p-3">
        <p className="text-[12px] text-paper">继续 SFTP 任务</p>
        <p className="text-[11px] leading-relaxed text-mist">重启应用后请重新输入账号密码。凭据仅保存在本次运行的内存中；继续使用创建任务时已核实的服务器指纹。</p>
        <input aria-label="继续 SFTP 的用户名" value={username} onChange={event => setUsername(event.target.value)} maxLength={256} disabled={busy} autoComplete="off" placeholder="用户名" className="w-full rounded-control border border-line bg-raised px-2.5 py-2 text-[12px] text-paper" />
        <input aria-label="继续 SFTP 的密码" type="password" value={password} onChange={event => setPassword(event.target.value)} maxLength={4096} disabled={busy} autoComplete="new-password" placeholder="密码" className="w-full rounded-control border border-line bg-raised px-2.5 py-2 text-[12px] text-paper" />
        <button type="button" className={control} disabled={busy || !username.trim() || !password} onClick={() => void run(async () => {
          const current = generation.current, captured = currentSnapshot.current!
          let reply: unknown
          try { reply = await window.ndm?.request('auxiliaryAuthenticate', { taskID, generation: captured.generation, credentials: { username, password }, autoStart: true }) }
          catch { throw new Error('认证与继续操作尚未确认，请刷新原任务核对。') }
          finally { if (generation.current === current) setPassword('') }
          if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) throw new Error(auxiliaryErrorMessage(reply, '未能继续原任务，请核对认证信息后重试。'))
          await refresh(current, true); await changed()
        })}>认证并继续原任务</button>
      </div> : null}
      {snapshot.kind === 'bittorrent' || snapshot.kind === 'ed2k' ? <>
        <div className="grid grid-cols-2 gap-2 text-[12px] text-mist"><span>累计上传 {snapshot.uploadedBytes === undefined ? '暂不可用' : formatBytes(snapshot.uploadedBytes)}</span><span>分享率 {snapshot.ratio === undefined ? '暂不可用' : snapshot.ratio.toFixed(2)}</span></div>
        {snapshot.phase === 'seeding' ? <div className="space-y-2"><p className="text-[12px] text-mist">文件内容已下载，仍在向其他节点上传。停止做种后再核对任务交付状态。</p><button type="button" disabled={busy || capabilities?.stopSeeding !== true} className={control} onClick={() => void run(async () => {
          const current = generation.current, captured = currentSnapshot.current!
          let reply: unknown
          try { reply = await window.ndm?.request('auxiliaryStopSeeding', { taskID, generation: captured.generation }) } catch { throw new Error('停止做种结果尚未确认，请刷新状态核对。') }
          if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) throw new Error(auxiliaryErrorMessage(reply, '未能停止做种，请刷新状态核对。'))
          await refresh(current, true); await changed()
        })}><Square size={13} />{snapshot.kind === 'ed2k' ? '停止共享' : '停止做种'}</button>{capabilities?.stopSeeding !== true ? <p className="text-[11px] text-mist">当前引擎未提供停止共享操作。</p> : null}</div> : null}
        {snapshot.kind === 'bittorrent' && snapshot.files.length ? <>
          {!canSelect && !['complete', 'removed', 'seeding', 'metadata'].includes(snapshot.phase) ? <button type="button" disabled={busy || capabilities?.fileSelection !== true} className={control} onClick={() => void run(async () => {
            const current = generation.current
            let reply: unknown
            try { reply = await window.ndm?.request('pause', { taskID }) } catch { throw new Error('暂停结果尚未确认，请刷新状态核对。') }
            if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) throw new Error(auxiliaryErrorMessage(reply, '任务尚未确认暂停，无法修改文件选择。'))
            const next = await fetchStatus(taskID)
            if (generation.current === current) {
              accept(next, true)
              if (!['paused', 'awaitingSelection'].includes(next.phase)) throw new Error('引擎尚未确认暂停，请稍后重试。')
            }
          })}><Pause size={13} />暂停后选择文件</button> : null}
          {capabilities?.fileSelection !== true ? <p className="text-[12px] text-mist">当前引擎未提供文件选择能力。</p> : null}
          <input aria-label="查找种子文件" value={search} onChange={event => setSearch(event.target.value)} placeholder="按文件路径查找" className="w-full rounded-control border border-line bg-raised px-2.5 py-2 text-[12px] text-paper outline-none focus:border-copper/50" />
          <div className="flex items-center justify-between gap-2 text-[12px] text-mist"><label className="flex items-center gap-2"><input type="checkbox" aria-label="选择全部显示的文件" disabled={!canSelect || busy || !files.length} checked={files.length > 0 && files.every(file => selected.has(file.index))} onChange={event => {
            setSelected(previous => { const next = new Set(previous); for (const file of files) { if (event.target.checked) next.add(file.index); else next.delete(file.index) } return next }); dirtyRef.current = true; setSelectionDirty(true)
          }} />选择显示项</label><span>已选 {selected.size} / {snapshot.files.length} · {formatBytes(selectedBytes)}</span></div>
          <div ref={scrollElement} className="h-[280px] overflow-auto rounded-control border border-line">
            <ul style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>{virtualizer.getVirtualItems().map(virtual => {
              const file = files[virtual.index]
              return <li key={file.index} data-index={virtual.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtual.start}px)` }} className="border-b border-line p-2.5">
                <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" aria-label={`选择文件 ${file.relativePath}`} checked={selected.has(file.index)} disabled={!canSelect || busy} onChange={event => {
                  setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(file.index); else next.delete(file.index); return next }); dirtyRef.current = true; setSelectionDirty(true)
                }} /><span className="min-w-0"><span className="block break-all text-[12px] text-paper">{file.relativePath}</span><span className="mt-1 block text-[11px] tabular-nums text-mist">{formatBytes(file.completedLength)} / {formatBytes(file.length)}</span></span></label>
              </li>
            })}</ul>
          </div>
          {canSelect ? <div className="space-y-2"><label className="flex items-center gap-2 text-[12px] text-mist"><input type="checkbox" checked={autoStart} onChange={event => setAutoStart(event.target.checked)} disabled={busy} />确认后开始下载</label>{selectionDirty ? <p className="text-[11px] text-mist">文件选择尚未提交。</p> : null}<button type="button" disabled={busy || selected.size === 0} className={`${control} border-copper/30 bg-copper/10`} onClick={() => void run(async () => {
            const current = generation.current
            const request = auxiliarySelectionRequest(currentSnapshot.current!, [...selected], autoStart)
            let reply: unknown
            try { reply = await window.ndm?.request('auxiliarySelectFiles', request) } catch { throw new Error('文件选择结果尚未确认，请刷新状态核对后再操作。') }
            if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) throw new Error(auxiliaryErrorMessage(reply, '文件选择未能确认，请刷新状态后重试。'))
            await refresh(current, true); await changed()
          })}>确认选择 {selected.size} 个文件</button></div> : null}
        </> : null}
      </> : null}
    </> : null}
    {error ? <p role="alert" className="text-[12px] text-clay">{error}</p> : null}
  </section>
}
