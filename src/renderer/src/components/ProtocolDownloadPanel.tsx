import { useEffect, useRef, useState } from 'react'
import { FileUp, FolderOpen, ShieldCheck } from 'lucide-react'
import {
  AuxiliaryCreationController, auxiliaryErrorMessage, auxiliarySourceLabel, normalizeSFTPHostPin,
  readAuxiliaryCapabilities, supportsAuxiliaryProtocol, validateAuxiliaryCreate,
  type AuxiliaryCapabilities, type AuxiliaryCreationState, type AuxiliaryProtocol, type AuxiliarySource
} from '../../../shared/auxiliaryTransfer'

const control = 'inline-flex items-center justify-center gap-1.5 rounded-control border border-line px-3 py-2 text-[12px] text-paper hover:bg-raised disabled:opacity-40'
const input = 'w-full rounded-control border border-line bg-raised px-2.5 py-2 text-[12px] text-paper outline-none focus:border-copper/50 disabled:opacity-40'
// Volatile only: preserve one unacknowledged operation across Composer remounts.
// This intentionally never uses localStorage, sessionStorage, or composerDraft.
let pendingCreation: AuxiliaryCreationController | null = null
const transport = async (op: string, extra: Record<string, unknown>) => {
  if (!window.ndm) throw new Error('unavailable')
  return window.ndm.request(op, extra)
}

export function ProtocolDownloadPanel({ onCreated, initialURL = '' }: { onCreated?: (taskID: number) => void; initialURL?: string } = {}) {
  const [protocol, setProtocol] = useState<AuxiliaryProtocol>('magnet')
  const [url, setURL] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [hostPin, setHostPin] = useState('')
  const [torrent, setTorrent] = useState<{ token: string; filename: string } | null>(null)
  const [folderPath, setFolderPath] = useState('')
  const [autoStart, setAutoStart] = useState(true)
  const [capabilities, setCapabilities] = useState<AuxiliaryCapabilities | null>(null)
  const [creation, setCreation] = useState<AuxiliaryCreationState | null>(() => pendingCreation?.snapshot() ?? null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const working = useRef(true), mounted = useRef(true)
  const capabilitiesReady = !!capabilities && supportsAuxiliaryProtocol(capabilities, protocol)
  const locked = busy || !!creation
  const isBT = protocol === 'magnet' || protocol === 'torrent'
  let targetHost = ''
  try { if (protocol === 'sftp' && new URL(url).protocol === 'sftp:') targetHost = auxiliarySourceLabel({ kind: 'sftp', url, hostKeySHA256: '' }) } catch { /* Display no unvalidated source text. */ }

  useEffect(() => {
    if (pendingCreation || !initialURL) return
    const next = initialURL.trim()
    const kind = /^magnet:\?/i.test(next) ? 'magnet' : /^sftp:\/\//i.test(next) ? 'sftp' : /^ed2k:\/\//i.test(next) ? 'ed2k' : null
    if (!kind) return
    setProtocol(kind); setURL(next); setUsername(''); setPassword(''); setHostPin(''); setError('')
  }, [initialURL])

  const acceptCreation = (state: AuxiliaryCreationState) => {
    setCreation(state)
    if (state.phase === 'accepted') { pendingCreation = null; setPassword(''); setUsername(''); setURL(''); setHostPin(''); setTorrent(null); onCreated?.(state.taskID!) }
  }
  useEffect(() => {
    let cancelled = false
    mounted.current = true
    working.current = true
    void (async () => {
      try {
        try {
          const reply = await transport('auxiliaryCapabilities', {})
          if (!cancelled) {
            const available = readAuxiliaryCapabilities(reply)
            setCapabilities(available)
            if (!available) setError(auxiliaryErrorMessage(reply, '当前设备尚未提供辅助协议能力，请检查引擎后重试。'))
          }
        } catch { if (!cancelled) setError('当前设备尚未提供辅助协议能力，请检查引擎后重试。') }
        if (pendingCreation) {
          const state = await pendingCreation.reconcile(false)
          if (!cancelled) acceptCreation(state)
        }
      } catch { if (!cancelled) setError('当前设备尚未提供辅助协议能力，请检查引擎后重试。') }
      finally { if (!cancelled) { working.current = false; setBusy(false) } }
    })()
    return () => { cancelled = true; mounted.current = false }
  }, [])

  const run = async (action: () => Promise<void>) => {
    if (working.current) return
    working.current = true; setBusy(true); setError('')
    try { await action() }
    catch { if (mounted.current) setError('操作未能确认，请检查下载引擎后重试。') }
    finally { working.current = false; if (mounted.current) setBusy(false) }
  }
  const begin = () => {
    if (working.current || creation || !capabilitiesReady) return
    let source: AuxiliarySource
    if (protocol === 'torrent') {
      if (!torrent) { setError('请先选择本地种子文件。'); return }
      source = { kind: 'torrent', token: torrent.token }
    } else if (protocol === 'sftp') source = { kind: 'sftp', url, hostKeySHA256: hostPin }
    else source = { kind: protocol, url }
    try {
      const request = validateAuxiliaryCreate({ creationKey: crypto.randomUUID(), source, autoStart: isBT ? false : autoStart,
        ...(folderPath ? { folderPath } : {}), ...(protocol === 'sftp' ? { credentials: { username, password } } : {}) }, window.ndm?.platform === 'win32' ? 'win32' : 'posix')
      pendingCreation = new AuxiliaryCreationController(request, transport)
      setCreation(pendingCreation.snapshot())
      void run(async () => { const state = await pendingCreation!.reconcile(true); if (mounted.current) acceptCreation(state) })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '请检查协议参数。') }
  }

  return <section aria-label="协议下载" className="space-y-3 rounded-xl border border-line bg-panel/40 p-3.5">
    <div><h3 className="text-[13px] font-medium text-paper">协议下载</h3><p className="mt-1 text-[12px] leading-relaxed text-mist">添加磁力链接、种子文件、ED2K 或 SFTP 下载。</p></div>
    <div role="group" aria-label="下载协议" className="flex flex-wrap gap-1.5">{(['magnet', 'torrent', 'ed2k', 'sftp'] as const).map(value => <button key={value} type="button" disabled={locked} aria-pressed={protocol === value} onClick={() => { setProtocol(value); setError(''); setURL(''); setUsername(''); setPassword(''); setHostPin('') }} className={`${control} ${protocol === value ? 'border-copper/30 bg-copper/10' : 'text-mist'}`}>{value === 'magnet' ? '磁力链接' : value === 'torrent' ? '本地种子' : value.toUpperCase()}</button>)}</div>
    {!creation ? <>
      {!capabilitiesReady && !busy ? <p role="status" className="text-[12px] text-clay">当前设备的引擎尚不支持{isBT ? '安全的 BT 文件选择流程' : protocol.toUpperCase()}，此入口暂不可创建任务。</p> : null}
      {protocol === 'torrent' ? <div className="flex flex-wrap items-center gap-2"><button type="button" className={control} disabled={locked || !capabilitiesReady} onClick={() => void run(async () => {
        const raw = await transport('auxiliaryChooseTorrent', {}) as { ok?: boolean; torrent?: { token?: unknown; filename?: unknown } | null }
        if (raw?.ok !== true) { if (mounted.current) setError(auxiliaryErrorMessage(raw, '未能选择种子文件。')); return }
        if (raw.torrent === null) return
        if (typeof raw.torrent?.token !== 'string' || !/^[a-z\d_-]{16,128}$/i.test(raw.torrent.token)
            || typeof raw.torrent.filename !== 'string' || !raw.torrent.filename || raw.torrent.filename.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(raw.torrent.filename)) throw new Error('invalid torrent')
        if (mounted.current) setTorrent({ token: raw.torrent.token, filename: raw.torrent.filename })
      })}><FileUp size={14} />选择 .torrent 文件</button>{torrent ? <span className="break-all text-[12px] text-fog">{torrent.filename}</span> : null}</div>
        : <label className="block space-y-1 text-[12px] text-mist"><span>{protocol === 'sftp' ? 'SFTP 文件地址' : protocol === 'ed2k' ? 'ED2K 文件链接' : '磁力链接'}</span><textarea aria-label="协议下载地址" value={url} onChange={event => setURL(event.target.value)} rows={2} maxLength={65536} disabled={locked || !capabilitiesReady} spellCheck={false} autoComplete="off" className={`${input} resize-y font-mono`} placeholder={protocol === 'sftp' ? 'sftp://server.example.com/path/file.zip' : protocol === 'ed2k' ? 'ed2k://|file|filename|length|hash|/' : 'magnet:?xt=urn:btih:…'} /></label>}
      {protocol === 'sftp' ? <div className="space-y-2 rounded-control border border-line p-3">
        <p className="flex items-center gap-1.5 text-[12px] text-paper"><ShieldCheck size={14} />{targetHost && targetHost !== 'SFTP' ? targetHost : '请填写服务器地址'}</p>
        <div className="grid gap-2 sm:grid-cols-2"><input aria-label="SFTP 用户名" value={username} onChange={event => setUsername(event.target.value)} disabled={locked || !capabilitiesReady} maxLength={256} autoComplete="off" placeholder="用户名" className={input} /><input type="password" aria-label="SFTP 密码" value={password} onChange={event => setPassword(event.target.value)} disabled={locked || !capabilitiesReady} maxLength={4096} autoComplete="new-password" placeholder="密码" className={input} /></div>
        <label className="block space-y-1 text-[12px] text-mist"><span>服务器公钥 SHA-256 指纹（必填）</span><input aria-label="SFTP 主机指纹" value={hostPin} onChange={event => setHostPin(event.target.value)} disabled={locked || !capabilitiesReady} maxLength={128} spellCheck={false} autoComplete="off" placeholder="SHA256:…" className={`${input} font-mono`} /></label>
        {hostPin && !normalizeSFTPHostPin(hostPin) ? <p className="text-[11px] text-clay">指纹必须包含 32 字节 SHA-256 摘要的 Base64 值。</p> : null}
        <p className="text-[11px] leading-relaxed text-mist">请从服务器管理员或可信渠道核实指纹。指纹不符时停止连接；用户名和密码仅保存在当前应用内存中，任务确认创建后即清除表单副本。</p>
      </div> : null}
      <div className="flex flex-wrap items-center gap-2"><button type="button" className={control} disabled={locked || !capabilitiesReady} onClick={() => void run(async () => { const path = await window.ndm?.selectFolder(folderPath || undefined); if (path && mounted.current) setFolderPath(path) })}><FolderOpen size={14} />选择目标目录</button>{folderPath ? <><span className="break-all text-[12px] text-fog">{folderPath}</span><button type="button" className={control} disabled={locked} onClick={() => setFolderPath('')}>使用默认目录</button></> : <span className="text-[12px] text-mist">使用默认目录与目录规则</span>}</div>
      {!isBT ? <label className="flex items-center gap-2 text-[12px] text-mist"><input type="checkbox" checked={autoStart} onChange={event => setAutoStart(event.target.checked)} disabled={locked || !capabilitiesReady} />创建后开始下载</label> : <p className="text-[12px] text-mist">先读取元数据，再到任务详情选择文件；确认选择前不下载文件内容。</p>}
      <button type="button" className={`${control} border-copper/30 bg-copper/10`} disabled={locked || !capabilitiesReady || (protocol === 'torrent' ? !torrent : !url.trim())} onClick={begin}>{isBT ? '创建任务并读取元数据' : '创建下载任务'}</button>
    </> : <div className="space-y-2 rounded-control border border-line p-3">
      <p className="text-[12px] text-paper">{creation.label}</p>
      {creation.phase === 'accepted' ? <><p role="status" className="text-[12px] text-fog">已确认创建任务 #{creation.taskID}。BT 任务可在详情中选择文件。</p><button type="button" className={control} disabled={busy} onClick={() => { pendingCreation = null; setCreation(null); setError('') }}>添加另一任务</button></>
        : creation.phase === 'rejected' ? <><p role="status" className="text-[12px] text-clay">{creation.message}</p><button type="button" className={control} disabled={busy} onClick={() => { pendingCreation = null; setCreation(null); setError('') }}>修改参数</button></>
        : <><p role="status" className="text-[12px] text-mist">{creation.message ?? '正在核对并提交任务…'}</p><div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={busy} onClick={() => void run(async () => { const state = await pendingCreation!.reconcile(false); if (mounted.current) acceptCreation(state) })}>仅核对回执</button><button type="button" className={control} disabled={busy} onClick={() => void run(async () => { const state = await pendingCreation!.reconcile(true); if (mounted.current) acceptCreation(state) })}>核对并重试原请求</button></div><p className="text-[11px] text-mist">结果未确认时保留同一请求标识。关闭并重开此面板会先核对回执。</p></>}
    </div>}
    {!busy && !capabilitiesReady ? <button type="button" className={control} onClick={() => void run(async () => { const raw = await transport('auxiliaryCapabilities', {}); const next = readAuxiliaryCapabilities(raw); if (mounted.current) { setCapabilities(next); if (!next) setError(auxiliaryErrorMessage(raw, '当前设备尚未提供辅助协议能力。')) } })}>重新检查引擎能力</button> : null}
    {busy ? <p role="status" className="text-[12px] text-mist">正在处理…</p> : null}
    {error ? <p role="alert" className="text-[12px] text-clay">{error}</p> : null}
  </section>
}
