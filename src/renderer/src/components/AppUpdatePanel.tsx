import { useEffect, useRef, useState } from 'react'
import type { AppUpdateReply } from '../../../shared/appUpdate'
import { openExternal } from '../lib/store'

export function AppUpdatePanel() {
  const [reply, setReply] = useState<AppUpdateReply | null>(null)
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState(false)
  const pending = useRef(false), linkPending = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const check = async () => {
    if (pending.current || linkPending.current) return
    pending.current = true; setBusy(true); setReply(null); setOpenError(false)
    try {
      const result = await window.ndm?.request('checkAppUpdate') as AppUpdateReply | undefined
      if (mounted.current) setReply(result && ['release', 'unpublished', 'error'].includes(result.status) ? result : { status: 'error', reason: 'network' })
    } catch { if (mounted.current) setReply({ status: 'error', reason: 'network' }) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const open = async () => {
    if (linkPending.current || pending.current || reply?.status !== 'release') return
    linkPending.current = true; setOpening(true); setOpenError(false)
    try { if (!await openExternal(reply.url)) throw new Error('open failed') }
    catch { if (mounted.current) setOpenError(true) }
    finally { linkPending.current = false; if (mounted.current) setOpening(false) }
  }
  const message = reply?.status === 'unpublished' ? '未查到公开的正式版本，暂时无法判断当前版本是否最新。'
    : reply?.status === 'error' ? reply.reason === 'rateLimit' ? '检查过于频繁或服务暂时受限，请稍后重试。' : reply.reason === 'invalid' ? '发布信息暂时无法读取，请稍后重试。' : '暂时无法检查更新，请确认网络连接后重试。'
      : reply?.status === 'release' ? reply.relation === 'newer' ? `发现公开版本 ${reply.version}。`
        : reply.relation === 'current' ? `当前版本与最新公开版本 ${reply.version} 一致。`
          : reply.relation === 'older' ? `当前版本比最新公开版本 ${reply.version} 更新。` : `最新公开版本：${reply.version}。暂时无法比较版本号。` : null
  const control = 'rounded-control border border-line-strong px-3 py-2 text-[13px] text-paper hover:bg-line disabled:opacity-50'
  return <div className="space-y-2 pt-3" aria-label="版本更新">
    <div className="flex flex-wrap gap-2">
      <button type="button" className={control} disabled={busy || opening} onClick={() => void check()}>{busy ? '正在检查…' : reply?.status === 'error' ? '重试检查更新' : '检查更新'}</button>
      {reply?.status === 'release' ? <button type="button" className={control} disabled={opening} onClick={() => void open()}>{opening ? '正在打开…' : '查看发行说明'}</button> : null}
    </div>
    {message ? <p role={reply?.status === 'error' ? 'alert' : 'status'} className={`text-[13px] leading-relaxed ${reply?.status === 'error' ? 'text-clay' : 'text-fog'}`}>{message}</p> : <p className="text-[12px] text-mist">点击后检查 GitHub 上的公开正式版。</p>}
    {reply && reply.status !== 'error' ? <p className="text-[12px] text-mist">检查时间：{new Date(reply.checkedAt).toLocaleTimeString()}</p> : null}
    {openError ? <p role="alert" className="text-[13px] text-clay">未能打开发行说明，请在浏览器访问 github.com/gy-0/NDM-desktop/releases。</p> : null}
  </div>
}
