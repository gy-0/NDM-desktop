import { useEffect, useState } from 'react'
import { ChevronDown, RefreshCw, ShieldCheck } from 'lucide-react'
import { readSessionCookieBrowser, SESSION_BROWSER_OPTIONS, useSessionBrowser, writeSessionBrowser, writeSessionProfile, type SessionBrowser } from '../lib/sessionPrefs'
import type { BrowserSessionCatalog } from '../../../shared/browserSessions'
import { IS_WINDOWS } from '../lib/platform'

export function BrowserSessionSettings() {
  const browser = useSessionBrowser()
  const [revision, refresh] = useState(0)
  const [catalog, setCatalog] = useState<BrowserSessionCatalog | null>(null)
  const selection = readSessionCookieBrowser(browser)
  const profile = selection.includes(':') ? selection.slice(selection.indexOf(':') + 1) : ''
  useEffect(() => {
    let alive = true
    setCatalog(null)
    void window.ndm?.browserSessions?.(selection).then(value => { if (alive) setCatalog(value) }).catch(() => {
      if (alive) setCatalog({ browser, profiles: [], error: '暂时无法读取浏览器资料，请稍后重新检测。' })
    })
    return () => { alive = false }
  }, [browser, selection, revision])
  const control = 'h-9 w-full appearance-none rounded-control border border-line bg-panel pl-3 pr-9 text-body text-paper outline-none focus:border-copper'
  return <div className="space-y-3 py-3 text-body">
    <label className="flex items-center justify-between gap-4">
      <span className="font-medium text-paper">登录来源浏览器</span>
      <span className="relative w-40 shrink-0">
        <select aria-label="登录来源浏览器" className={control} value={browser} onChange={event => writeSessionBrowser(event.target.value as SessionBrowser)}>
          {SESSION_BROWSER_OPTIONS.filter(option => !IS_WINDOWS || option.value !== 'safari').map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-2.5 size-4 text-mist" />
      </span>
    </label>
    <div aria-live="polite" className="rounded-control border border-line/60 bg-panel/40 px-3 py-2.5">
      <p className="text-paper">{catalog?.source?.label ?? catalog?.error ?? '正在检测浏览器个人资料…'}</p>
      {catalog?.code === 'browserAccessDenied' && !IS_WINDOWS ? <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void window.ndm?.openPrivacySettings?.('files')}
          className="inline-flex h-8 items-center gap-1.5 rounded-control bg-copper px-3 text-label font-medium text-on-accent transition-opacity hover:opacity-90">
          <ShieldCheck aria-hidden className="size-3.5" />打开“完全磁盘访问”设置
        </button>
        <span className="text-meta text-mist">在列表中启用 NDM，然后回到这里重新检测。</span>
      </div> : null}
      {catalog?.error && (catalog.stage || catalog.cause || catalog.environment) ? <details className="mt-2 text-meta leading-relaxed text-mist">
        <summary className="cursor-pointer">诊断信息</summary>
        <div className="mt-1 space-y-1">
          {catalog.stage ? <p>阶段：{{resolve:'定位文件',open:'打开文件',stat:'检查文件',read:'读取文件',parse:'解析文件',shape:'识别资料结构'}[catalog.stage]}（{catalog.stage}）</p> : null}
          {catalog.cause ? <p>原因：{catalog.cause}</p> : null}
          {catalog.environment ? <p>目录检查：{catalog.environment.homeMatchesAppHome === true ? '系统用户目录一致' : catalog.environment.homeMatchesAppHome === false ? '系统用户目录不一致' : '系统用户目录待确认'} · {catalog.environment.rootResolved ? '来源路径已确定' : '来源路径未确定'}</p> : null}
        </div>
      </details> : null}
      <p className="mt-1 text-meta leading-relaxed text-mist">{catalog?.source?.selection === 'automatic' ? '自动跟随该浏览器记录的当前个人资料；不会逐个尝试其他账号。' : profile ? '已固定使用此个人资料；重试不会自动换成其他资料。' : '只读取该浏览器的登录来源，不会合并不同浏览器的会话。'}</p>
    </div>
    <details className="text-mist">
      <summary className="cursor-pointer py-1 text-paper">高级：手动选择个人资料</summary>
      <div className="mt-2 space-y-2">
        <span className="relative block">
          <select aria-label="登录来源个人资料" className={control} value={profile} onChange={event => { writeSessionProfile(browser, event.target.value); refresh(value => value + 1) }}>
            <option value="">自动（浏览器当前使用的个人资料）</option>
            {profile && !catalog?.profiles.some(item => item.id === profile) ? <option value={profile}>{profile}（不可用）</option> : null}
            {catalog?.profiles.map(item => <option key={item.id} value={item.id}>{item.label}（{item.id}）{item.current ? ' · 当前' : ''}</option>)}
          </select>
          <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-2.5 size-4" />
        </span>
        <p className="text-meta">请与浏览器右上角正在使用的个人资料保持一致。</p>
      </div>
    </details>
    <button type="button" onClick={() => refresh(value => value + 1)} className="inline-flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1.5 text-mist hover:text-paper"><RefreshCw aria-hidden className="size-3.5" />重新检测</button>
    <p className="text-meta leading-relaxed text-mist">从 NDM 浏览器扩展发送的页面，优先使用该页面所在资料的会话。登录失效时，请回到同一浏览器资料确认网站可正常播放，再重试。</p>
  </div>
}
