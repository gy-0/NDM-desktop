import { useEffect, useRef, useState } from 'react'
import { Pause, RefreshCw, Save } from 'lucide-react'
import { readAuxiliarySnapshot } from '../../../shared/auxiliaryTransfer'
import {
  BT_ERROR_MESSAGES, BT_MAX_SEED_MINUTES, BT_MAX_UPLOAD_LIMIT, btSafeFailure, canConfigureBT, parseBTTrackerLines, readBTControlsState, readBTGlobalState,
  validateBTPeers, validateBTTaskConfig, type BTControlsState, type BTEncryption, type BTGlobalState, type BTTaskConfig
} from '../../../shared/btTransferControls'
import { formatBytes } from '../lib/format'

const button = 'inline-flex items-center justify-center gap-1.5 rounded-control border border-line px-2.5 py-2 text-meta text-paper hover:bg-raised disabled:opacity-40'
const input = 'w-full rounded-control border border-line bg-raised px-2.5 py-2 text-meta text-paper outline-none focus:border-copper/50 disabled:opacity-50'
type Draft = { trackers: string; webSeeds: string; seedRatio: string; seedMinutes: string; uploadLimit: string; peerExchange: boolean }
const draftFor = (config: BTTaskConfig): Draft => ({ trackers: config.trackers.map(tracker => `${tracker.tier} ${tracker.url}`).join('\n'),
  webSeeds: config.webSeeds.join('\n'), seedRatio: String(config.seedRatio), seedMinutes: config.seedMinutes === null ? '' : String(config.seedMinutes),
  uploadLimit: String(config.uploadLimit), peerExchange: config.peerExchange })
const encryptionLabels: Record<BTEncryption, string> = { preferred: '优先加密', required: '必须加密', disabled: '禁用加密' }
const trackerStatus = (status: string): string => ({ idle: '等待', announcing: '连接中', working: '正常', active: '正常', error: '失败', updating: '更新中', waiting: '等待', disabled: '已禁用' }[status] ?? '待确认')
const peerState = (state: string): string => ({ connecting: '连接中', handshaking: '握手中', connected: '已连接' }[state] ?? '待确认')
const endpointLabel = (url: string): string => { try { return new URL(url).host } catch { return 'Tracker' } }

export function BitTorrentControlsPanel({ taskID, onChanged }: { taskID: number; onChanged?: () => void | Promise<void> }) {
  const [state, setState] = useState<BTControlsState | null>(null)
  const [global, setGlobal] = useState<BTGlobalState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false), [revision, setRevision] = useState(0)
  const [encryption, setEncryption] = useState<BTEncryption>('preferred')
  const [encryptionDirty, setEncryptionDirty] = useState(false), [encryptionRevision, setEncryptionRevision] = useState(0)
  const [allConfirmed, setAllConfirmed] = useState(false)
  const [peerText, setPeerText] = useState(''), [peerPage, setPeerPage] = useState(0)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [isBT, setIsBT] = useState<boolean | null>(null)
  const lifetime = useRef(0), operation = useRef(0), working = useRef(false)
  const dirtyRef = useRef(false), encryptionDirtyRef = useRef(false), currentState = useRef<BTControlsState | null>(null)

  const acceptTask = (next: BTControlsState, reset = false) => {
    const changed = currentState.current && currentState.current.generation !== next.generation
    currentState.current = next; setState(next)
    if (reset || changed || !dirtyRef.current) {
      setDraft(draftFor(next.config)); setRevision(next.revision); dirtyRef.current = false; setDirty(false)
    }
    if (changed) { setPeerText(''); setError(BT_ERROR_MESSAGES.staleGeneration) }
  }
  const acceptGlobal = (next: BTGlobalState, reset = false) => {
    setGlobal(next)
    if (reset || !encryptionDirtyRef.current) {
      setEncryption(next.encryption); setEncryptionRevision(next.revision); setEncryptionDirty(false); encryptionDirtyRef.current = false; setAllConfirmed(false)
    }
  }
  const fetchTask = async (): Promise<BTControlsState | null> => {
    const auxiliary = readAuxiliarySnapshot(await window.ndm?.request('auxiliaryStatus', { taskID }), taskID)
    if (!auxiliary) throw new Error(BT_ERROR_MESSAGES.unavailable)
    if (auxiliary.kind !== 'bittorrent') return null
    const reply = await window.ndm?.request('auxiliaryBTStatus', { taskID, generation: auxiliary.generation })
    const next = readBTControlsState(reply, taskID, auxiliary.generation)
    if (!next) throw new Error(btSafeFailure(reply).error)
    return next
  }
  const refresh = async (reset = false) => {
    const current = lifetime.current
    const [taskResult, globalResult] = await Promise.allSettled([fetchTask(), window.ndm?.request('auxiliaryBTGlobalStatus', {})])
    if (lifetime.current !== current) return
    if (taskResult.status === 'rejected') throw new Error(BT_ERROR_MESSAGES.unavailable)
    setIsBT(!!taskResult.value)
    if (taskResult.value) acceptTask(taskResult.value, reset)
    if (globalResult.status === 'fulfilled') {
      const next = readBTGlobalState(globalResult.value)
      if (next) acceptGlobal(next, reset)
      else { setGlobal(null); setError(btSafeFailure(globalResult.value).error) }
    } else { setGlobal(null); setError(BT_ERROR_MESSAGES.unavailable) }
  }

  useEffect(() => {
    const current = ++lifetime.current
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    currentState.current = null; dirtyRef.current = false; encryptionDirtyRef.current = false; working.current = false
    setState(null); setGlobal(null); setDraft(null); setDirty(false); setEncryptionDirty(false); setAllConfirmed(false)
    setError(''); setNotice(''); setPeerText(''); setPeerPage(0); setIsBT(null); setBusy(false); setLoading(true)
    const poll = async () => {
      const sequence = operation.current
      if (!working.current) {
        try {
          const [taskResult, globalResult] = await Promise.allSettled([fetchTask(), window.ndm?.request('auxiliaryBTGlobalStatus', {})])
          if (stopped || lifetime.current !== current) return
          if (sequence === operation.current) {
            if (taskResult.status === 'fulfilled') {
              setIsBT(!!taskResult.value)
              if (taskResult.value) acceptTask(taskResult.value)
            } else setError(BT_ERROR_MESSAGES.unavailable)
            const nextGlobal = globalResult.status === 'fulfilled' ? readBTGlobalState(globalResult.value) : null
            if (nextGlobal) acceptGlobal(nextGlobal)
            else setGlobal(null)
          }
        } catch { if (!stopped && lifetime.current === current) setError(BT_ERROR_MESSAGES.unavailable) }
      }
      if (!stopped && lifetime.current === current) { setLoading(false); timer = setTimeout(() => void poll(), 2500) }
    }
    void poll()
    return () => { stopped = true; lifetime.current++; if (timer) clearTimeout(timer) }
  }, [taskID])

  const run = async (action: (current: number) => Promise<void>) => {
    if (working.current) return
    const current = lifetime.current
    operation.current++; working.current = true; setBusy(true); setError(''); setNotice('')
    try { await action(current) }
    catch (reason) {
      if (lifetime.current === current) setError(reason instanceof Error && Object.values(BT_ERROR_MESSAGES).includes(reason.message as never) ? reason.message : BT_ERROR_MESSAGES.unconfirmed)
    } finally { if (lifetime.current === current) { working.current = false; setBusy(false) } }
  }
  const changed = () => Promise.resolve().then(() => onChanged?.()).catch(() => undefined)
  const edit = (values: Partial<Draft>) => { setDraft(previous => previous ? { ...previous, ...values } : previous); dirtyRef.current = true; setDirty(true) }
  const editable = !!state && canConfigureBT(state.phase) && !busy
  const conflict = !!state && dirty && state.revision !== revision
  const globalConflict = !!global && encryptionDirty && global.revision !== encryptionRevision
  const page = Math.min(peerPage, Math.max(0, Math.ceil((state?.peers.length ?? 0) / 50) - 1))

  if (isBT === false) return null
  return <section aria-label="BT 连接与分享" className="space-y-3 border-t border-line pt-4">
    <div className="flex items-center justify-between gap-2"><h3 className="text-body font-medium text-paper">BT 连接与分享</h3><button type="button" className={button} disabled={busy || loading} onClick={() => void run(async () => refresh())}><RefreshCw size={13} />刷新</button></div>
    {loading ? <p role="status" className="text-meta text-mist">正在读取 BT 配置…</p> : null}
    {state && draft ? <>
      {!canConfigureBT(state.phase) ? <div className="space-y-2"><p className="text-meta text-mist">配置与手动 peer 仅在任务暂停后修改。当前连接信息会自动刷新。</p>{['downloading', 'seeding', 'checking', 'metadata'].includes(state.phase) ? <button type="button" className={button} disabled={busy} onClick={() => void run(async current => {
        const reply = await window.ndm?.request('pause', { taskID })
        if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) throw new Error(BT_ERROR_MESSAGES.unconfirmed)
        if (lifetime.current === current) { await refresh(); await changed() }
      })}><Pause size={13} />暂停以编辑</button> : null}</div> : null}
      <details className="rounded-control border border-line p-3" open>
        <summary className="cursor-pointer text-meta font-medium text-paper">Tracker 与 WebSeed</summary>
        <div className="mt-3 space-y-3">
          <label className="block space-y-1 text-meta text-mist"><span>Tracker · 每行“层级 地址”，层级为 0–255；省略则为 0</span><textarea aria-label="BT Tracker 列表" className={`${input} min-h-[100px] font-mono`} value={draft.trackers} disabled={!editable} spellCheck={false} onChange={event => edit({ trackers: event.target.value })} /></label>
          <label className="block space-y-1 text-meta text-mist"><span>WebSeed · 每行一个 HTTP 或 HTTPS 地址</span><textarea aria-label="BT WebSeed 列表" className={`${input} min-h-[80px] font-mono`} value={draft.webSeeds} disabled={!editable} spellCheck={false} onChange={event => edit({ webSeeds: event.target.value })} /></label>
          <p className="text-caption text-mist">保存会替换本任务的列表；空列表表示清除。带令牌的地址仅保留在任务配置中。</p>
          {state.trackers.length ? <ul className="max-h-[140px] overflow-auto space-y-1 text-caption text-mist">{state.trackers.map((tracker, index) => <li key={`${index}:${tracker.tier}`} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{tracker.tier} · {endpointLabel(tracker.url)}</span><span>{trackerStatus(tracker.status)} · 做种 {tracker.seeders < 0 ? '—' : tracker.seeders} / 下载 {tracker.leechers < 0 ? '—' : tracker.leechers}</span></li>)}</ul> : null}
        </div>
      </details>
      <div className="space-y-3 rounded-control border border-line p-3">
        <h4 className="text-meta font-medium text-paper">本任务分享策略</h4>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-meta text-mist"><span>目标分享率</span><input aria-label="BT 目标分享率" className={input} type="number" min="0" max="1000000" step="0.1" value={draft.seedRatio} disabled={!editable} onChange={event => edit({ seedRatio: event.target.value })} /></label>
          <label className="space-y-1 text-meta text-mist"><span>做种分钟数</span><input aria-label="BT 做种分钟数" className={input} type="number" min="0" max={BT_MAX_SEED_MINUTES} step="1" placeholder="不设时间" value={draft.seedMinutes} disabled={!editable} onChange={event => edit({ seedMinutes: event.target.value })} /></label>
        </div>
        <p className="text-caption leading-relaxed text-mist">分享率 1 表示上传与下载等量，0 表示不按分享率停止。时间留空表示不设时间，0 表示下载后不做种；任一已设目标达到后结束分享。</p>
        <label className="block space-y-1 text-meta text-mist"><span>本任务上传上限（字节/秒，0 不限速）</span><input aria-label="BT 上传上限" className={input} type="number" min="0" max={BT_MAX_UPLOAD_LIMIT} step="1" value={draft.uploadLimit} disabled={!editable} onChange={event => edit({ uploadLimit: event.target.value })} /></label>
        <label className="flex gap-2 text-meta text-mist"><input type="checkbox" aria-label="BT 启用 PEX" checked={draft.peerExchange} disabled={!editable} onChange={event => edit({ peerExchange: event.target.checked })} />通过 PEX 交换 peer 信息（私有种子仍遵守引擎限制）</label>
      </div>
      {dirty ? <p role="status" className={`text-caption ${conflict ? 'text-clay' : 'text-mist'}`}>{conflict ? BT_ERROR_MESSAGES.conflict : '编辑尚未保存；刷新不会覆盖编辑内容。'}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${button} border-copper/30 bg-copper/10`} disabled={!editable || !dirty || conflict} onClick={() => void run(async current => {
          let config: BTTaskConfig
          try {
            if (!draft.seedRatio.trim() || !draft.uploadLimit.trim()) throw new Error()
            config = validateBTTaskConfig({ trackers: parseBTTrackerLines(draft.trackers), webSeeds: draft.webSeeds.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
              seedRatio: Number(draft.seedRatio), seedMinutes: draft.seedMinutes.trim() === '' ? null : Number(draft.seedMinutes), uploadLimit: Number(draft.uploadLimit), peerExchange: draft.peerExchange })
          } catch { throw new Error(BT_ERROR_MESSAGES.invalidConfig) }
          const binding = { taskID, generation: state.generation }
          const reply = await window.ndm?.request('auxiliaryBTConfigure', { ...binding, expectedRevision: revision, config })
          const next = readBTControlsState(reply, taskID, binding.generation)
          if (!next) throw new Error(btSafeFailure(reply, 'unconfirmed').error)
          if (lifetime.current === current) { acceptTask(next, true); setNotice('配置已保存并由引擎确认。'); await changed() }
        })}><Save size={13} />保存本任务配置</button>
        <button type="button" className={button} disabled={busy || !dirty} onClick={() => { acceptTask(state, true); setNotice('已恢复当前已保存配置。') }}>放弃编辑，读取当前配置</button>
      </div>
      <details className="rounded-control border border-line p-3">
        <summary className="cursor-pointer text-meta font-medium text-paper">Peer · {state.peers.length} 个</summary>
        <div className="mt-3 space-y-3">
          <div className="max-h-[260px] overflow-auto"><table className="w-full text-left text-caption tabular-nums text-mist"><thead><tr><th className="py-1 font-normal">地址</th><th className="font-normal">下载 / 上传</th><th className="font-normal">状态</th></tr></thead><tbody>{state.peers.slice(page * 50, page * 50 + 50).map((peer, index) => <tr key={`${peer.ip}:${peer.port}:${index}`} className="border-t border-line"><td className="py-2 break-all">{peer.ip.includes(':') ? `[${peer.ip}]` : peer.ip}:{peer.port}<br />{(peer.progress * 100).toFixed(1)}%{peer.seeder ? ' · 做种' : ''}</td><td>{formatBytes(peer.downloadSpeed)}/s<br />{formatBytes(peer.uploadSpeed)}/s</td><td>{peerState(peer.state)}<br />{peer.encryption === 'plain' ? '未加密' : ['rc4', 'tls', 'encryptedHandshake'].includes(peer.encryption) ? '已加密' : '待确认'}</td></tr>)}</tbody></table>{!state.peers.length ? <p className="py-3 text-meta text-mist">当前没有 peer 连接。</p> : null}</div>
          {state.peers.length > 50 ? <div className="flex items-center justify-between"><button type="button" className={button} disabled={page === 0} onClick={() => setPeerPage(page - 1)}>上一页</button><span className="text-caption text-mist">{page + 1} / {Math.ceil(state.peers.length / 50)}</span><button type="button" className={button} disabled={(page + 1) * 50 >= state.peers.length} onClick={() => setPeerPage(page + 1)}>下一页</button></div> : null}
          <label className="block space-y-1 text-meta text-mist"><span>手动添加 peer · 每行 IP:端口或 [IPv6]:端口</span><textarea aria-label="手动 BT peer" className={`${input} min-h-[64px] font-mono`} value={peerText} disabled={!editable} spellCheck={false} onChange={event => setPeerText(event.target.value)} /></label>
          <button type="button" className={button} disabled={!editable || !peerText.trim()} onClick={() => void run(async current => {
            let peers: string[]
            try { peers = validateBTPeers(peerText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) } catch { throw new Error(BT_ERROR_MESSAGES.invalidPeers) }
            const reply = await window.ndm?.request('auxiliaryBTAddPeers', { taskID, generation: state.generation, peers })
            if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true || !('added' in reply) || !('failed' in reply)) throw new Error(btSafeFailure(reply, 'unconfirmed').error)
            if (lifetime.current === current) { setNotice(`已接受 ${reply.added} 个 peer，失败 ${reply.failed} 个；接受不代表已连接，恢复下载后查看连接信息。`); if (reply.failed === 0) setPeerText(''); await refresh() }
          })}>添加 peer</button>
        </div>
      </details>
    </> : null}
    {global ? <div className="space-y-2 rounded-control border border-line p-3">
      <h4 className="text-meta font-medium text-paper">BT 会话加密 · 应用于全部 BT 任务</h4>
      <p className="text-caption text-mist">这项设置影响整个 BT 引擎，并在下次启动时保留。请先暂停全部 BT 任务。</p>
      <select aria-label="BT 会话加密" className={input} value={encryption} disabled={busy || !global.canConfigure} onChange={event => { setEncryption(event.target.value as BTEncryption); setEncryptionDirty(true); encryptionDirtyRef.current = true; setAllConfirmed(false) }}>{Object.entries(encryptionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      {encryptionDirty ? <><label className="flex gap-2 text-meta text-mist"><input type="checkbox" checked={allConfirmed} disabled={busy} onChange={event => setAllConfirmed(event.target.checked)} />确认应用于全部 BT 任务</label>{globalConflict ? <p className="text-caption text-clay">{BT_ERROR_MESSAGES.conflict}</p> : null}<div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !global.canConfigure || !allConfirmed || globalConflict} onClick={() => void run(async current => {
        const reply = await window.ndm?.request('auxiliaryBTGlobalConfigure', { expectedRevision: encryptionRevision, encryption })
        const next = readBTGlobalState(reply)
        if (!next) throw new Error(btSafeFailure(reply, 'unconfirmed').error)
        if (lifetime.current === current) { acceptGlobal(next, true); setNotice('全部 BT 任务的加密策略已保存并确认。'); await changed() }
      })}>应用于全部 BT 任务</button><button type="button" className={button} disabled={busy} onClick={() => acceptGlobal(global, true)}>恢复当前加密策略</button></div></> : null}
      {!global.canConfigure ? <p className="text-caption text-mist">还有 BT 任务未暂停，暂时不能更改。</p> : null}
    </div> : null}
    {notice ? <p role="status" className="text-meta text-mist">{notice}</p> : null}
    {error ? <p role="alert" className="text-meta text-clay">{error}</p> : null}
  </section>
}
