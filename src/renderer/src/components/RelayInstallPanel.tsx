import { useEffect, useState } from 'react'
import { ExternalLink, FolderOpen } from 'lucide-react'
import type { RelayDistribution } from '../../../shared/relayDistribution'
import { openPath } from '../lib/store'

/** Shared by onboarding and settings so release installation has one source of truth. */
export function RelayInstallPanel() {
  const [distribution, setDistribution] = useState<RelayDistribution | null>(null)
  const [directory, setDirectory] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void Promise.resolve(window.ndm?.relayDistribution?.()).then(async value => {
      if (!active) return
      if (!value) { setFailed(true); return }
      setDistribution(value)
      if (value.mode === 'development') {
        const path = await window.ndm?.extensionPath?.()
        if (active) setDirectory(path ?? null)
      }
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])
  const open = async () => {
    if (busy || !distribution) return
    setBusy(true); setMessage('')
    try {
      if (distribution.mode === 'store') {
        if (!await window.ndm?.openExternal?.(distribution.url)) throw new Error('open failed')
        setMessage('已打开商店。请在需要接管下载的浏览器中安装，完成后会自动检测连接。')
      } else if (directory) {
        if (await openPath(directory)) throw new Error('open failed')
        setMessage('已打开扩展目录，加载后会自动检测连接。')
      }
    } catch { setMessage(distribution.mode === 'store' ? '未能打开商店，请重试。' : '未能打开扩展目录，请重试。') }
    finally { setBusy(false) }
  }
  if (failed) return <p role="status" className="text-body text-mist">暂时无法读取扩展安装信息，请重新打开此页面。</p>
  if (!distribution) return <p role="status" className="text-body text-mist">正在读取安装信息…</p>
  return <div className="space-y-3 text-body leading-relaxed text-mist">
    {distribution.mode === 'store' ? <>
      <p>从 Chrome Web Store 安装 NDM Relay，即可把浏览器中的下载交给 NDM。</p>
      <button type="button" onClick={() => void open()} disabled={busy}
        className="inline-flex items-center gap-2 rounded-control bg-copper px-3 py-2 font-medium text-on-accent disabled:opacity-50">
        <ExternalLink size={15} aria-hidden />{busy ? '正在打开…' : '前往 Chrome Web Store'}
      </button>
    </> : <>
      <p>此版本暂未提供 NDM Relay 的商店安装入口。现在可以粘贴链接下载，商店入口将随后续版本提供。</p>
      {distribution.mode === 'development' ? <details className="border-t border-line/60 pt-3">
        <summary className="cursor-pointer text-fog">开发测试安装</summary>
        <p className="mt-2">在浏览器扩展页开启开发者模式，选择“加载已解压的扩展程序”，选取下面的扩展目录。</p>
        <button type="button" className="mt-2 inline-flex items-center gap-2 font-medium text-copper disabled:opacity-50"
          disabled={!directory || busy} onClick={() => void open()}><FolderOpen size={15} aria-hidden />{busy ? '正在打开…' : '打开扩展目录'}</button>
        {!directory ? <p>测试扩展目录暂不可用。</p> : null}
      </details> : null}
    </>}
    {message ? <p role="status">{message}</p> : null}
  </div>
}
