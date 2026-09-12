import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Slider as BaseSlider } from '@base-ui/react/slider'
import { ArrowLeft, CheckCircle2, Crown, Download, Folder, Gauge, Info, Network, PackageOpen, Palette, Puzzle, Radio, Sparkles, Volume2 } from 'lucide-react'
import { cue, setSoundEnabled, setSoundVolume, soundEnabled, soundVolume } from '../lib/sound'
import { chooseFolder, getEngineSettings, openPath, updateEngineSettings } from '../lib/store'
import { readProgressEffects, writeProgressEffects, readProgressStyle, writeProgressStyle, type ProgressStyle } from '../lib/presentationPrefs'
import { readSessionBrowser, useSessionBrowser, writeSessionBrowser, SESSION_BROWSER_OPTIONS, type SessionBrowser } from '../lib/sessionPrefs'
import { COMMERCIALIZATION_DRAFT_ENABLED } from '../lib/commercialization'
import { PRO_PRICING, formatActivatedAt, useLicense } from '../lib/license'
import { THEMES, type ThemeId } from '../lib/themes'
import type { EngineSettings } from '../lib/types'
import { CONNECTION_OPTIONS, IS_WINDOWS } from '../lib/platform'
import { readSidebarWidth } from '../lib/layoutPrefs'
import { activeProxyKind, formatProxyEndpoint, parseProxyEndpoint, type ProxyEndpointError } from '../../../shared/proxyEndpoint'
import { SegmentedControl } from './SegmentedControl'
import { SquareChoice } from './SquareChoice'
import { Toggle } from './ui/Toggle'
import { CopyFeedback } from './ui/CopyFeedback'
import { useCopyFeedback } from '../hooks/useCopyFeedback'
import { describeRelayStatus, parseRelayBridgeStatus, type RelayBridgeStatus } from '../lib/relayStatus'
import type { TemporaryBandwidthSnapshot } from '../../../shared/temporaryBandwidth'

type SettingsPage = 'general' | 'appearance' | 'downloads' | 'network' | 'extensions'

const SETTINGS_PAGES = [
  { id: 'general', label: '通用', icon: Gauge },
  { id: 'appearance', label: '外观与声音', icon: Palette },
  { id: 'downloads', label: '下载', icon: Download },
  { id: 'network', label: '网络', icon: Network },
  { id: 'extensions', label: '浏览器扩展', icon: Puzzle }
] as const satisfies ReadonlyArray<{ id: SettingsPage; label: string; icon: typeof Gauge }>

const BANDWIDTH_PRESETS = [
  { number: '不限速', unit: '', val: 0 },
  { number: '1', unit: 'MB/s', val: 1048576 },
  { number: '5', unit: 'MB/s', val: 5242880 },
  { number: '10', unit: 'MB/s', val: 10485760 }
] as const

export function Settings({
  open,
  temporaryBandwidth,
  themeId,
  onTheme,
  onClose,
  onUpgrade,
  onRedeem,
  onReonboard,
  onClearHistory
}: {
  open: boolean
  temporaryBandwidth?: TemporaryBandwidthSnapshot
  themeId: ThemeId
  onTheme: (id: ThemeId) => void
  onClose: () => void
  onUpgrade: () => void
  onRedeem: () => void
  onReonboard: () => void
  onClearHistory: () => void
}) {
  const license = useLicense()
  const [sound, setSound] = useState(soundEnabled)
  const [volume, setVolume] = useState(soundVolume)
  const [activePage, setActivePage] = useState<SettingsPage>('general')
  const settingsRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }) }, [activePage])
  const [engineSettings, setEngineSettings] = useState<EngineSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [downloadDirectoryError, setDownloadDirectoryError] = useState('')
  const [savingConnections, setSavingConnections] = useState(false)
  const [savingAllAtOnce, setSavingAllAtOnce] = useState(false)
  const [downloadSettingsError, setDownloadSettingsError] = useState('')
  const [savingDestinationPrompt, setSavingDestinationPrompt] = useState(false)
  const [destinationPromptError, setDestinationPromptError] = useState('')
  const [savingCategoryFolders, setSavingCategoryFolders] = useState(false)
  const [categoryFoldersError, setCategoryFoldersError] = useState('')
  const [savingInstallerDisposition, setSavingInstallerDisposition] = useState(false)
  const [installerDispositionError, setInstallerDispositionError] = useState('')
  const [savingBandwidth, setSavingBandwidth] = useState(false)
  const [bandwidthError, setBandwidthError] = useState('')
  const [bandwidthInputInvalid, setBandwidthInputInvalid] = useState(false)
  const [extensionDir, setExtensionDir] = useState<string | null>(null)
  const [extensionPathCopied, copyExtensionPath, extensionPathCopyError] = useCopyFeedback()
  const [relayStatus, setRelayStatus] = useState<RelayBridgeStatus | null>(null)
  const [relayStatusError, setRelayStatusError] = useState(false)
  const [customBandwidth, setCustomBandwidth] = useState('')
  const editingCustomBandwidth = useRef(false)
  const [httpProxyText, setHttpProxyText] = useState('')
  const [socksProxyText, setSocksProxyText] = useState('')
  const [httpProxyError, setHttpProxyError] = useState('')
  const [socksProxyError, setSocksProxyError] = useState('')
  const [savingHttpProxy, setSavingHttpProxy] = useState(false)
  const [savingSocksProxy, setSavingSocksProxy] = useState(false)
  const [progressEffects, setProgressEffects] = useState(readProgressEffects)
  const [progressStyle, setProgressStyle] = useState<ProgressStyle>(readProgressStyle)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const sessionBrowser = useSessionBrowser()
  const setSessionBrowser = (browser: SessionBrowser): void => writeSessionBrowser(browser)

  useEffect(() => {
    if (!open || !temporaryBandwidth) return
    let active = true
    // An expiry can happen while Settings is open. Refresh the saved speed
    // without replacing unsaved folder, proxy, or custom-speed input.
    void getEngineSettings().then(settings => {
      if (!active || !settings) return
      setEngineSettings(previous => previous
        ? { ...previous, bandwidthLimitBytesPerSecond: settings.bandwidthLimitBytesPerSecond }
        : settings)
      if (!editingCustomBandwidth.current) {
        const rate = settings.bandwidthLimitBytesPerSecond
        setCustomBandwidth([0, 1048576, 5242880, 10485760].includes(rate) ? '' : String(Math.round(rate / 1048576 * 100) / 100))
      }
    }).catch(() => {})
    return () => { active = false }
  }, [open, temporaryBandwidth?.status, temporaryBandwidth?.limitBytesPerSecond])

  useEffect(() => {
    if (open) {
      setSidebarWidth(readSidebarWidth())
      let active = true
      let settingsTimer: ReturnType<typeof setTimeout> | undefined
      setDownloadSettingsError('')
      setCategoryFoldersError('')
      setInstallerDispositionError('')
      setBandwidthError('')
      setBandwidthInputInvalid(false)
      setHttpProxyError('')
      setSocksProxyError('')

      const loadSettings = (attempt = 0): void => {
        void getEngineSettings().then((s) => {
          if (!active) return
          if (!s) throw new Error('missing engine settings')
          setEngineSettings(s)
          const fixed = [0, 1048576, 5242880, 10485760]
          if (!fixed.includes(s.bandwidthLimitBytesPerSecond)) {
            setCustomBandwidth(String(Math.round((s.bandwidthLimitBytesPerSecond / 1048576) * 10) / 10))
          }
          // Controlled proxy fields: an uncontrolled defaultValue mounts before
          // this async load resolves and would show empty on first open.
          setHttpProxyText(s.httpProxyHost ? formatProxyEndpoint(s.httpProxyHost, s.httpProxyPort || 8080) : '')
          setSocksProxyText(s.socksProxyHost ? formatProxyEndpoint(s.socksProxyHost, s.socksProxyPort || 1080) : '')
        }).catch(() => {
          if (!active) return
          if (attempt < 3) {
            settingsTimer = setTimeout(() => loadSettings(attempt + 1), 400)
          } else {
            setDownloadSettingsError('未能读取下载设置。请关闭设置后重试。')
          }
        })
      }

      loadSettings()
      void window.ndm?.extensionPath?.().then((dir) => setExtensionDir(dir ?? null))
      return () => {
        active = false
        if (settingsTimer) clearTimeout(settingsTimer)
      }
    }
  }, [open])

  useEffect(() => {
    if (!open || activePage !== 'extensions' || IS_WINDOWS) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setRelayStatus(null)
    setRelayStatusError(false)
    const refresh = async (): Promise<void> => {
      try {
        const reply = await window.ndm?.request('getBridgeStatus')
        const value = parseRelayBridgeStatus(reply)
        if (active) {
          setRelayStatus(value)
          setRelayStatusError(false)
        }
      } catch {
        if (active) { setRelayStatus(null); setRelayStatusError(true) }
      } finally {
        if (active) timer = setTimeout(() => { void refresh() }, 2000)
      }
    }
    void refresh()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [open, activePage])

  if (!open) return null
  const relayPresentation = describeRelayStatus(relayStatus, relayStatusError)

  const handleSelectFolder = async (): Promise<void> => {
    const selected = await chooseFolder(engineSettings?.downloadDirectory)
    if (selected && engineSettings) {
      setSaving(true)
      setDownloadDirectoryError('')
      try {
        const saved = await updateEngineSettings({ downloadDirectory: selected })
        if (!saved) throw new Error('missing saved settings')
        setEngineSettings(saved)
        cue('success')
      } catch {
        setDownloadDirectoryError('未能保存下载目录。请检查目录和下载引擎后重试。')
      } finally {
        setSaving(false)
      }
    }
  }

  const handleUpdateConnections = async (conns: number): Promise<void> => {
    if (!engineSettings || savingConnections) return
    setSavingConnections(true)
    setDownloadSettingsError('')
    try {
      const saved = await updateEngineSettings({ maxConnections: conns })
      if (!saved) throw new Error('missing saved settings')
      // The engine is authoritative: Windows currently caps aria2 at 16,
      // while the native macOS engine supports 32.
      setEngineSettings(saved)
    } catch {
      setDownloadSettingsError('未能保存连接数。请重试。')
    } finally {
      setSavingConnections(false)
    }
  }

  const handleToggleAllAtOnce = async (): Promise<void> => {
    if (!engineSettings || savingAllAtOnce) return
    const nextValue = !engineSettings.downloadAllAtOnce
    setSavingAllAtOnce(true)
    setDownloadSettingsError('')
    try {
      const saved = await updateEngineSettings({ downloadAllAtOnce: nextValue })
      if (!saved) throw new Error('missing saved settings')
      setEngineSettings(saved)
    } catch {
      setDownloadSettingsError('未能保存任务并行设置。请重试。')
    } finally {
      setSavingAllAtOnce(false)
    }
  }

  const handleDestinationPrompt = async (): Promise<void> => {
    if (!engineSettings || savingDestinationPrompt) return
    setSavingDestinationPrompt(true); setDestinationPromptError('')
    try {
      const saved = await updateEngineSettings({ askBrowserDownloadDestination: !engineSettings.askBrowserDownloadDestination })
      if (!saved) throw new Error('missing settings')
      setEngineSettings(saved)
    } catch { setDestinationPromptError('未能保存设置，请重试。') }
    finally { setSavingDestinationPrompt(false) }
  }

  const handleToggleCategoryFolders = async (): Promise<void> => {
    if (!engineSettings || savingCategoryFolders) return
    const nextVal = !engineSettings.useCategoryFolders
    setSavingCategoryFolders(true)
    setCategoryFoldersError('')
    try {
      const saved = await updateEngineSettings({ useCategoryFolders: nextVal })
      if (!saved) throw new Error('missing saved settings')
      setEngineSettings(saved)
    } catch {
      setCategoryFoldersError('未能保存分类设置。请重试。')
    } finally {
      setSavingCategoryFolders(false)
    }
  }

  const handleBandwidth = async (bytesPerSecond: number): Promise<void> => {
    if (!engineSettings || savingBandwidth) return
    setSavingBandwidth(true)
    setBandwidthError('')
    setBandwidthInputInvalid(false)
    try {
      const saved = await updateEngineSettings({
        bandwidthLimitBytesPerSecond: Math.max(0, Math.round(bytesPerSecond))
      })
      if (!saved) throw new Error('missing saved settings')
      setEngineSettings(saved)
    } catch {
      setBandwidthError('未能保存带宽限制。请重试。')
    } finally {
      setSavingBandwidth(false)
    }
  }

  const handleInstallerDisposition = async (value: 'ask' | 'trash' | 'keep'): Promise<void> => {
    if (!engineSettings || savingInstallerDisposition) return
    setSavingInstallerDisposition(true)
    setInstallerDispositionError('')
    try {
      const saved = await updateEngineSettings({ installerSourceDisposition: value })
      if (!saved) throw new Error('missing saved settings')
      setEngineSettings(saved)
    } catch {
      setInstallerDispositionError('未能保存安装包处理方式。请重试。')
    } finally {
      setSavingInstallerDisposition(false)
    }
  }

  const handleClose = (): void => {
    onClose()
  }

  const applyCustomBandwidth = (): void => {
    const mb = Number(customBandwidth)
    if (!customBandwidth.trim() || !Number.isFinite(mb) || mb <= 0) {
      setBandwidthError('请输入大于 0 的速度，例如 2.5 MB/s。')
      setBandwidthInputInvalid(true)
      return
    }
    void handleBandwidth(mb * 1048576)
  }

  const proxyFormatError = (error: ProxyEndpointError): string => {
    if (error === 'ipv6Brackets') return 'IPv6 地址请使用 [地址]:端口，例如 [::1]:7890。'
    if (error === 'port') return '端口请输入 1–65535 之间的整数。'
    return '请输入主机或“主机:端口”，例如 127.0.0.1:7890。'
  }

  const saveProxy = async (kind: 'http' | 'socks'): Promise<void> => {
    const isHTTP = kind === 'http'
    const text = isHTTP ? httpProxyText : socksProxyText
    const parsed = parseProxyEndpoint(text, isHTTP ? 8080 : 1080)
    const setError = isHTTP ? setHttpProxyError : setSocksProxyError
    const setSavingProxy = isHTTP ? setSavingHttpProxy : setSavingSocksProxy
    if (!parsed.ok) {
      setError(proxyFormatError(parsed.error))
      return
    }

    setError('')
    setSavingProxy(true)
    try {
      const endpoint = parsed.endpoint
      const patch: Partial<EngineSettings> = isHTTP
        ? {
            httpProxyHost: endpoint?.host ?? '',
            httpProxyPort: endpoint?.port,
            httpProxyEnabled: Boolean(endpoint),
            ...(endpoint ? { socksProxyEnabled: false } : {})
          }
        : {
            socksProxyHost: endpoint?.host ?? '',
            socksProxyPort: endpoint?.port,
            socksProxyEnabled: Boolean(endpoint),
            ...(endpoint ? { httpProxyEnabled: false } : {})
          }
      const saved = await updateEngineSettings(patch)
      if (!saved) throw new Error('missing saved settings')
      setEngineSettings(saved)
      setHttpProxyText(saved.httpProxyHost
        ? formatProxyEndpoint(saved.httpProxyHost, saved.httpProxyPort || 8080)
        : '')
      setSocksProxyText(saved.socksProxyHost
        ? formatProxyEndpoint(saved.socksProxyHost, saved.socksProxyPort || 1080)
        : '')
      cue('success')
    } catch {
      setError(`未能保存${isHTTP ? ' HTTP / HTTPS' : ' SOCKS5'}代理。请重试。`)
    } finally {
      setSavingProxy(false)
    }
  }

  const activeProxy = activeProxyKind(engineSettings ?? {})

  const disableProxy = async (): Promise<void> => {
    if (!activeProxy) return
    const setError = activeProxy === 'http' ? setHttpProxyError : setSocksProxyError
    const setSavingProxy = activeProxy === 'http' ? setSavingHttpProxy : setSavingSocksProxy
    setError('')
    setSavingProxy(true)
    try {
      const saved = await updateEngineSettings({
        httpProxyEnabled: false,
        socksProxyEnabled: false
      })
      if (!saved) throw new Error('missing saved settings')
      setEngineSettings(saved)
    } catch {
      setError('未能停用代理。请重试。')
    } finally {
      setSavingProxy(false)
    }
  }

  const activePageTitle = SETTINGS_PAGES.find((page) => page.id === activePage)?.label ?? '设置'

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
    <Dialog.Portal>
    <Dialog.Popup
      ref={settingsRef}
      aria-describedby={undefined}
      initialFocus={() => {
        const previous = document.activeElement
        returnFocus.current = previous instanceof HTMLElement && previous !== document.body && !previous.closest('[role="dialog"], [role="alertdialog"]')
          ? previous
          : document.querySelector<HTMLElement>('[data-settings-trigger]')
        return settingsRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? settingsRef.current
      }}
      finalFocus={() => {
        // Settings can hand off to onboarding or a confirmation dialog. Those
        // surfaces own the next focus; returning to the workspace would steal it.
        const nextDialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
          .some(element => element !== settingsRef.current && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
        if (nextDialog) return false
        return returnFocus.current?.isConnected
          ? returnFocus.current
          : document.querySelector<HTMLElement>('[data-settings-trigger]') ?? document.getElementById('ndm-search')
      }}
      className="ndm-settings fixed inset-0 z-70 flex bg-ink"
    >
      <aside
        data-sidebar-width={sidebarWidth}
        className="flex h-full shrink-0 flex-col border-e border-line bg-panel"
        style={{ width: sidebarWidth }}
      >
        <div className="app-drag h-[52px] shrink-0 border-b border-line/60" />
        <div className="px-2 pb-2 pt-2">
          <button
            type="button"
            data-cuelume-press
            data-cuelume-release
            onClick={handleClose}
            className="app-no-drag mb-3 flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[13px] text-fog transition-colors duration-100 hover:bg-raised/45 hover:text-paper active:bg-raised"
          >
            <ArrowLeft size={14} strokeWidth={1.8} />
            返回应用
          </button>
          <Dialog.Title className="px-2 pb-2 text-[19px] font-semibold tracking-[-0.025em] text-paper">设置</Dialog.Title>
        </div>
        <nav className="px-2" aria-label="设置分类">
          <div className="flex flex-col gap-px">
            {SETTINGS_PAGES.map((page) => {
              const Icon = page.icon
              const active = page.id === activePage
              return (
                <button
                  key={page.id}
                  type="button"
                  data-cuelume-press
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setActivePage(page.id)}
                  className={`ndm-navigation-row flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[13px] transition-colors duration-100 active:bg-raised ${
                    active ? 'bg-raised font-medium text-paper' : 'text-fog hover:bg-raised/45 hover:text-paper'
                  }`}
                >
                  <Icon size={14} strokeWidth={active ? 2 : 1.65} className="shrink-0" />
                  <span className="min-w-0 flex-1">{page.label}</span>
                </button>
              )
            })}
          </div>
        </nav>
        <div className="mt-auto border-t border-line/50 px-4 py-3 text-[11.5px] text-mist">
          <span className="inline-flex items-center gap-1.5"><Info size={12} />NDM Desktop · v{window.ndm?.version ?? '开发版'}</span>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-ink">
        <header className="app-drag flex h-[52px] shrink-0 items-center justify-between border-b border-line/60 px-6">
          <span className="text-[13px] font-medium text-mist">{activePageTitle}</span>
          <button
            type="button"
            data-cuelume-press
            data-cuelume-release
            className="app-no-drag rounded-control px-2.5 py-1 text-[13px] font-medium text-fog transition-[color,background-color,scale] duration-100 hover:bg-raised/45 hover:text-paper active:scale-[0.96]"
            onClick={handleClose}
          >
            完成
          </button>
        </header>

        <div ref={contentRef} className="settings-content flex-1 overflow-y-auto scroll-quiet" data-active-page={activePage}>
          <div className="mx-auto w-full max-w-[760px] space-y-8 px-10 py-9">
          {COMMERCIALIZATION_DRAFT_ENABLED ? (
            <Section title="NDM Pro" page="general">
              <div className="space-y-3 text-[13px]">
                <div className="flex items-start justify-between gap-3">
                  <span className="flex items-center gap-1.5 font-medium text-paper">
                    <Crown size={14} strokeWidth={1.6} className="text-copper" />
                    <span>{license ? 'NDM Pro' : 'NDM 免费版'}</span>
                  </span>
                  {license ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-sage">
                      <CheckCircle2 size={11} /> 已激活
                    </span>
                  ) : (
                    <span className="shrink-0 text-[12px] text-mist">免费档</span>
                  )}
                </div>

                {license ? (
                  <div className="space-y-1.5">
                    <Line label="邮箱" value={license.email || '未记录'} />
                    <Line label="激活码" value={license.key} />
                    <Line label="激活时间" value={formatActivatedAt(license.activatedAt)} />
                    <Line label="授权范围" value={`个人 · 最多 ${PRO_PRICING.seats} 台 Mac`} />
                  </div>
                ) : (
                  <p className="text-[13px] leading-relaxed text-mist">
                    免费档已包含多线程加速、断点续传与 Relay 接管。Pro 草案包含播放列表整批下载、4K / 8K、历史云同步与格式转换，
                    {PRO_PRICING.earlyBird} 早鸟一次性买断（原价 {PRO_PRICING.regular}），没有订阅。
                  </p>
                )}

                <div className="flex items-center gap-2 pt-0.5">
                  {license ? (
                    <button type="button" data-cuelume-press onClick={onUpgrade} className="text-[13px] font-medium text-copper transition-colors hover:text-paper">
                      查看授权
                    </button>
                  ) : (
                    <>
                      <button type="button" data-cuelume-press data-cuelume-release onClick={onUpgrade} className="inline-flex items-center gap-1 rounded-md bg-copper px-2.5 py-1 text-[13px] font-medium text-on-accent transition-[filter,scale] duration-100 hover:brightness-105 active:scale-[0.96]">
                        <Sparkles size={11} strokeWidth={2} /> 升级
                      </button>
                      <button type="button" data-cuelume-press onClick={onRedeem} className="text-[13px] text-fog transition-colors hover:text-paper">
                        输入激活码
                      </button>
                    </>
                  )}
                </div>
                <div className="border-t border-line/60 pt-2.5">
                  <button type="button" data-cuelume-press onClick={onReonboard} className="text-[13px] text-mist underline decoration-line-strong underline-offset-2 transition-colors hover:text-paper">
                    重新查看新手引导
                  </button>
                </div>
              </div>
            </Section>
          ) : (
            <Section title="Beta 计划" page="general">
              <div className="space-y-3 text-[13px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-paper">当前版本开放全部已实现能力</span>
                  <span className="shrink-0 text-[12px] font-medium text-sage">Beta</span>
                </div>
                <p className="text-[13px] leading-relaxed text-mist">
                  测试期间开放全部下载功能。
                </p>
              <div className="border-t border-line/60 pt-2.5">
                <button
                  type="button"
                  data-cuelume-press
                  onClick={onReonboard}
                  className="text-[13px] text-copper transition-colors hover:underline"
                >
                  重新引导
                </button>
                <span className="ml-2 text-[13px] text-mist">查看添加下载和浏览器接管的用法。</span>
              </div>
            </div>
            </Section>
          )}

          {/* Appearance Section */}
          <Section title="界面外观" page="appearance">
            <p className="mb-3 text-[13px] leading-relaxed text-mist">选择适合当前环境的外观。</p>
            <div className="divide-y divide-line">
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  data-cuelume-toggle
                  aria-pressed={theme.id === themeId}
                  onClick={() => onTheme(theme.id)}
                  className={`group/theme flex w-full items-center gap-3 rounded-[9px] px-2.5 py-2.5 text-left transition-[background-color,color] duration-150 ${
                    theme.id === themeId ? 'bg-raised text-paper' : 'text-fog hover:bg-raised/55 hover:text-paper'
                  }`}
                >
                  <Swatch id={theme.id} selected={theme.id === themeId} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{theme.name}</span>
                    <span className="block text-[13px] text-mist">{theme.line}</span>
                  </span>
                  <span className={`shrink-0 text-[11px] transition-opacity duration-150 ${theme.id === themeId ? 'text-copper opacity-100' : 'opacity-0 group-hover/theme:opacity-60'}`}>
                    当前
                  </span>
                </button>
              ))}
            </div>
          </Section>

          {/* Download Directory & Concurrency */}
          <Section title="保存与文件" page="downloads">
            <div className="divide-y divide-line/50">
              <div className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-medium text-paper">默认保存目录</div>
                  <div
                    className="mt-0.5 truncate font-sans text-[13px] text-mist"
                    title={engineSettings?.downloadDirectory}
                  >
                    {engineSettings?.downloadDirectory || '正在读取...'}
                  </div>
                </div>
                <button
                  type="button"
                  data-cuelume-press
                  disabled={!engineSettings || saving}
                  aria-busy={saving}
                  aria-describedby={downloadDirectoryError ? 'download-directory-status' : undefined}
                  onClick={handleSelectFolder}
                  className="shrink-0 text-[13px] font-medium text-copper transition-colors hover:text-paper disabled:opacity-55"
                >
                  {saving ? '保存中...' : '选取...'}
                </button>
              </div>

              <p
                id="download-directory-status"
                role="status"
                aria-live="polite"
                className={downloadDirectoryError ? 'py-2 text-[13px] text-clay' : 'sr-only'}
              >
                {downloadDirectoryError}
              </p>

              <div>
                <div className="flex items-center justify-between gap-4 py-3">
                  <span className="text-[14px] font-medium text-paper">浏览器下载前选择保存目录</span>
                  <Toggle checked={engineSettings?.askBrowserDownloadDestination ?? false}
                    disabled={!engineSettings} busy={savingDestinationPrompt} label="浏览器下载前选择保存目录"
                    onCheckedChange={() => void handleDestinationPrompt()} />
                </div>
                {destinationPromptError ? <p role="status" className="text-[12px] text-clay">{destinationPromptError}</p> : null}
              </div>

              <div>
                <div className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <span className="block text-[14px] font-medium text-paper">按文件类型分类保存</span>
                    <span className="block text-[13px] text-mist">自动将视频/音频/文档归类到对应子目录</span>
                  </div>
                  <Toggle
                    checked={engineSettings?.useCategoryFolders ?? false}
                    onCheckedChange={() => void handleToggleCategoryFolders()}
                    label="按文件类型分类保存"
                    disabled={!engineSettings}
                    busy={savingCategoryFolders}
                    aria-describedby={categoryFoldersError ? 'category-folders-status' : undefined}
                  />
                </div>
                <p
                  id="category-folders-status"
                  role="status"
                  aria-live="polite"
                  className={categoryFoldersError ? 'pb-2 text-[13px] text-clay' : 'sr-only'}
                >
                  {categoryFoldersError}
                </p>
              </div>

              {!IS_WINDOWS ? (
                <div className="py-3">
                  <div className="flex items-start gap-2.5">
                    <PackageOpen size={15} strokeWidth={1.6} className="mt-0.5 shrink-0 text-mist" />
                    <div className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium text-paper">应用安装完成后</span>
                      <span className="block text-[13px] leading-relaxed text-mist">处理已经用完的 DMG 安装包</span>
                    </div>
                  </div>
                  <SegmentedControl
                    className="mt-2.5"
                    value={engineSettings?.installerSourceDisposition ?? 'ask'}
                    disabled={!engineSettings || savingInstallerDisposition}
                    aria-label="安装完成后处理 DMG"
                    aria-busy={savingInstallerDisposition}
                    onChange={(value) => void handleInstallerDisposition(value)}
                    options={[
                      { value: 'ask', label: '每次询问' },
                      { value: 'trash', label: '自动清理' },
                      { value: 'keep', label: '始终保留' }
                    ]}
                  />
                  <p className="mt-1.5 text-[13px] leading-relaxed text-mist">“自动清理”只会移到废纸篓，不会永久删除。</p>
                  <p
                    role="status"
                    aria-live="polite"
                    className={installerDispositionError ? 'mt-1 text-[13px] text-clay' : 'sr-only'}
                  >
                    {installerDispositionError}
                  </p>
                </div>
              ) : null}
            </div>
          </Section>

          <Section title="下载性能" page="downloads">
            <div className="divide-y divide-line/50">
              <div className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0 pr-4">
                  <span className="block text-[14px] font-medium text-paper">同时下载多个任务</span>
                  <span className="block text-[13px] text-mist">关闭后按队列逐个下载，切换时无需暂停当前任务</span>
                </div>
                <Toggle
                  checked={engineSettings?.downloadAllAtOnce ?? false}
                  onCheckedChange={() => void handleToggleAllAtOnce()}
                  label="同时下载多个任务"
                  disabled={!engineSettings}
                  busy={savingAllAtOnce}
                />
              </div>

              <p
                id="connection-setting-status"
                role="status"
                aria-live="polite"
                className={downloadSettingsError ? 'py-2 text-[13px] text-clay' : 'sr-only'}
              >
                {downloadSettingsError}
              </p>

              <div className="py-3">
                <div>
                  <span className="block text-[14px] font-medium text-paper">{IS_WINDOWS ? '全局带宽限速' : '默认文件限速'}</span>
                  <span className="block text-[13px] leading-relaxed text-mist" data-settings-bandwidth-hint>
                    {temporaryBandwidth && temporaryBandwidth.status !== 'inactive'
                      ? temporaryBandwidth.status === 'restoring' ? '正在恢复原限速。'
                        : temporaryBandwidth.status === 'checking' ? '正在确认临时限速。'
                          : `${new Date(temporaryBandwidth.expiresAt!).toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'})} 自动恢复原限速。手动修改将结束临时限速。`
                      : IS_WINDOWS ? '控制全局最大下载速度' : '普通文件按此限速；单项设置优先。'}
                  </span>
                </div>
                <div
                  role="group"
                  aria-label={IS_WINDOWS ? '全局带宽限速' : '默认文件限速'}
                  aria-busy={savingBandwidth}
                  aria-describedby={bandwidthError ? 'bandwidth-settings-status' : undefined}
                  className="mt-3 flex items-center gap-4"
                >
                  <SegmentedControl
                    className="min-w-0 flex-1"
                    value={engineSettings?.bandwidthLimitBytesPerSecond ?? 0}
                    disabled={!engineSettings || savingBandwidth}
                    onChange={(val) => void handleBandwidth(val)}
                    options={BANDWIDTH_PRESETS.map((tier) => ({
                      value: tier.val,
                      label: tier.unit ? (
                        <span className="inline-flex items-baseline justify-center gap-1.5 leading-none">
                          <span className="font-mono text-[14px] tabular-nums">{tier.number}</span>
                          <span className="text-[11px] leading-none text-mist">{tier.unit}</span>
                        </span>
                      ) : (
                        tier.number
                      )
                    }))}
                  />
                  <label
                    className={`flex h-8 min-w-[88px] items-center gap-2 border-b transition-[border-color] duration-150 ${
                      ![0, 1048576, 5242880, 10485760].includes(engineSettings?.bandwidthLimitBytesPerSecond ?? 0)
                        ? 'border-line-strong'
                        : 'border-line focus-within:border-copper/55'
                    }`}
                  >
                    <input
                      value={customBandwidth}
                      onFocus={() => { editingCustomBandwidth.current = true }}
                      onChange={(event) => {
                        setCustomBandwidth(event.target.value.replace(/[^0-9.]/g, ''))
                        if (bandwidthError) setBandwidthError('')
                        if (bandwidthInputInvalid) setBandwidthInputInvalid(false)
                      }}
                      onBlur={(event) => {
                        editingCustomBandwidth.current = false
                        // A preset click is the user's explicit choice. Avoid racing it
                        // with a custom-value save triggered by this field losing focus.
                        if (event.relatedTarget instanceof HTMLButtonElement) return
                        applyCustomBandwidth()
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          event.currentTarget.blur()
                        }
                      }}
                      inputMode="decimal"
                      aria-label="自定义下载速度，每秒 MB"
                      aria-invalid={bandwidthInputInvalid}
                      aria-describedby={bandwidthError ? 'bandwidth-settings-status' : undefined}
                      aria-busy={savingBandwidth}
                      disabled={!engineSettings || savingBandwidth}
                      placeholder="自定义"
                      className="min-w-0 flex-1 bg-transparent text-right font-mono text-[14px] tabular-nums text-fog outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-mist/55 disabled:cursor-wait disabled:opacity-55"
                    />
                    <span className="whitespace-nowrap text-[10px] leading-none text-mist">MB/s</span>
                  </label>
                </div>
                <p
                  id="bandwidth-settings-status"
                  role="status"
                  aria-live="polite"
                  className={bandwidthError ? 'mt-1.5 text-[13px] text-clay' : 'sr-only'}
                >
                  {bandwidthError}
                </p>
              </div>

              <details className="py-3">
                <summary className="cursor-pointer text-[13px] text-mist hover:text-paper">高级连接设置</summary>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="block text-[14px] font-medium text-paper">单任务最大连接数</span>
                    <span className="block text-[13px] text-mist">仅在排查下载问题时调整</span>
                  </div>
                  <SquareChoice
                    value={engineSettings?.maxConnections ?? CONNECTION_OPTIONS[1]}
                    options={CONNECTION_OPTIONS}
                    disabled={!engineSettings || savingConnections}
                    aria-label="单任务最大连接数"
                    aria-busy={savingConnections}
                    aria-describedby={downloadSettingsError ? 'connection-setting-status' : undefined}
                    onChange={(num) => void handleUpdateConnections(num)}
                  />
                </div>
              </details>
            </div>
          </Section>

          <Section title="下载进度" page="appearance">
            <div className="divide-y divide-line/50">
              <div className="flex items-center justify-between gap-4 py-3">
                <div>
                  <span className="block text-[14px] font-medium text-paper">下载进度样式</span>
                  <span className="block text-[13px] text-mist">分段模式展示真实并行传输</span>
                </div>
                <SegmentedControl
                  fit="hug"
                  value={progressStyle}
                  onChange={(value) => {
                    setProgressStyle(value)
                    writeProgressStyle(value)
                  }}
                  options={[
                    { value: 'continuous', label: '连续' },
                    { value: 'segmented', label: '分段' }
                  ]}
                />
              </div>

              <div className="flex items-center justify-between gap-4 py-3">
                <div>
                  <span className="block text-[14px] font-medium text-paper">进度条动效</span>
                  <span className="block text-[13px] text-mist">让下载进度平滑流动。</span>
                </div>
                <Toggle checked={progressEffects} label="进度条动效" onCheckedChange={(enabled) => {
                  setProgressEffects(enabled)
                  writeProgressEffects(enabled)
                }} />
              </div>
            </div>
          </Section>



          <Section title="下载记录" page="downloads">
            <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
              <p className="text-mist">清除已完成或失败的记录，保留下载文件。</p>
              <button type="button" onClick={onClearHistory} className="h-8 rounded-control border border-line-strong px-3 text-fog transition-colors hover:bg-raised hover:text-paper">
                清除下载记录…
              </button>
            </div>
          </Section>

          {/* Network & Proxy */}
          <Section title="网络" page="network">
            <div className="space-y-3 text-[13px]">
              <div className="flex items-start justify-between gap-3">
                <p className="leading-relaxed text-mist">可保留两项地址，但同一时间只使用一种。</p>
                {activeProxy ? (
                  <button
                    type="button"
                    data-cuelume-press
                    onClick={() => void disableProxy()}
                    disabled={savingHttpProxy || savingSocksProxy}
                    className="shrink-0 text-[13px] text-copper transition-colors hover:text-paper disabled:opacity-60"
                  >
                    停用代理
                  </button>
                ) : (
                  <span className="shrink-0 text-[13px] text-mist/70">未启用</span>
                )}
              </div>
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex shrink-0 items-center gap-1.5">
                    <label htmlFor="http-proxy" className="text-mist">HTTP / HTTPS 代理</label>
                    {engineSettings?.httpProxyHost ? (
                      activeProxy === 'http' ? (
                        <span data-proxy-state="http" className="text-[13px] text-copper">使用中</span>
                      ) : (
                        <button
                          type="button"
                          data-cuelume-press
                          data-proxy-state="http"
                          aria-label="使用 HTTP / HTTPS 代理"
                          onClick={() => void saveProxy('http')}
                          disabled={savingHttpProxy || savingSocksProxy}
                          className="text-[13px] text-copper transition-colors hover:text-paper disabled:opacity-60"
                        >
                          使用
                        </button>
                      )
                    ) : null}
                  </div>
                  <input
                    id="http-proxy"
                    name="http-proxy"
                    value={httpProxyText}
                    onChange={(event) => {
                      setHttpProxyText(event.target.value)
                      if (httpProxyError) setHttpProxyError('')
                    }}
                    onBlur={() => void saveProxy('http')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    placeholder="例如 127.0.0.1:7890"
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-invalid={Boolean(httpProxyError)}
                    aria-describedby={httpProxyError ? 'http-proxy-error' : undefined}
                    aria-busy={savingHttpProxy}
                    disabled={savingHttpProxy}
                    className="flex-1 border-b border-line bg-transparent px-0 py-1 font-mono text-[13px] text-fog outline-none placeholder:text-mist/50 aria-[invalid=true]:border-clay disabled:opacity-60"
                  />
                </div>
                <p id="http-proxy-error" role="status" aria-live="polite" className={`mt-1 min-h-[16px] text-right text-[13px] leading-4 text-clay ${httpProxyError ? 'visible' : 'invisible'}`}>
                  {httpProxyError}
                </p>
              </div>
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex shrink-0 items-center gap-1.5">
                    <label htmlFor="socks-proxy" className="text-mist">SOCKS5 代理</label>
                    {engineSettings?.socksProxyHost ? (
                      activeProxy === 'socks' ? (
                        <span data-proxy-state="socks" className="text-[13px] text-copper">使用中</span>
                      ) : (
                        <button
                          type="button"
                          data-cuelume-press
                          data-proxy-state="socks"
                          aria-label="使用 SOCKS5 代理"
                          onClick={() => void saveProxy('socks')}
                          disabled={savingHttpProxy || savingSocksProxy}
                          className="text-[13px] text-copper transition-colors hover:text-paper disabled:opacity-60"
                        >
                          使用
                        </button>
                      )
                    ) : null}
                  </div>
                  <input
                    id="socks-proxy"
                    name="socks-proxy"
                    value={socksProxyText}
                    onChange={(event) => {
                      setSocksProxyText(event.target.value)
                      if (socksProxyError) setSocksProxyError('')
                    }}
                    onBlur={() => void saveProxy('socks')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    placeholder="例如 127.0.0.1:10808"
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-invalid={Boolean(socksProxyError)}
                    aria-describedby={socksProxyError ? 'socks-proxy-error' : undefined}
                    aria-busy={savingSocksProxy}
                    disabled={savingSocksProxy}
                    className="flex-1 border-b border-line bg-transparent px-0 py-1 font-mono text-[13px] text-fog outline-none placeholder:text-mist/50 aria-[invalid=true]:border-clay disabled:opacity-60"
                  />
                </div>
                <p id="socks-proxy-error" role="status" aria-live="polite" className={`mt-1 min-h-[16px] text-right text-[13px] leading-4 text-clay ${socksProxyError ? 'visible' : 'invisible'}`}>
                  {socksProxyError}
                </p>
              </div>
            </div>
          </Section>

          {/* Sound & Audio Effects */}
          <Section title="声音与反馈" page="appearance">
            <div className="divide-y divide-line">
              <div className="flex items-center justify-between gap-4 py-3">
                <span>
                  <span className="block text-[14px] font-medium text-paper">操作提示音</span>
                  <span className="block text-[13px] text-mist">点击、完成与状态切换时发出轻声反馈</span>
                </span>
                <Toggle
                  checked={sound}
                  onCheckedChange={(next) => {
                    setSound(next)
                    setSoundEnabled(next)
                  }}
                  label="操作提示音"
                />
              </div>
              {sound ? (
                <div className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-[13px] text-fog">
                      <Volume2 size={14} />
                      提示音音量
                    </span>
                    <span className="font-mono text-[13px] tabular-nums text-mist">{Math.round(volume * 100)}%</span>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <BaseSlider.Root
                      value={Math.round(volume * 100)}
                      min={20}
                      max={100}
                      step={5}
                      onValueChange={(value) => {
                        const next = value / 100
                        setVolume(next)
                        setSoundVolume(next)
                      }}
                      className="min-w-0 flex-1"
                    >
                      <BaseSlider.Control className="flex h-7 w-full items-center">
                        <BaseSlider.Track className="relative h-1 w-full rounded-full bg-line-strong">
                          <BaseSlider.Indicator className="block h-full rounded-full bg-accent" />
                          <BaseSlider.Thumb
                            aria-label="提示音音量"
                            aria-valuetext={`${Math.round(volume * 100)}%`}
                            className="relative z-10 block size-[14px] rounded-full bg-raised shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_42%,transparent),0_1px_3px_rgb(0_0_0/0.22)] outline-none transition-[scale,box-shadow] duration-150 hover:scale-[1.08] focus-within:scale-[1.08] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_16%,transparent),0_1px_4px_rgb(0_0_0/0.24)]"
                          />
                        </BaseSlider.Track>
                      </BaseSlider.Control>
                    </BaseSlider.Root>
                    <button
                      type="button"
                      onClick={() => cue('success')}
                      className="shrink-0 text-[13px] text-copper transition-colors hover:text-paper active:scale-[0.96]"
                    >
                      试听
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </Section>

          {/* Browser Extension Support */}
          <Section title="浏览器扩展" page="extensions">
            {IS_WINDOWS ? (
              <div className="space-y-2 text-[13px]">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-medium text-paper">
                    <Puzzle size={14} strokeWidth={1.5} />
                    Windows Relay
                  </span>
                  <span className="text-[12px] text-clay">后续版本</span>
                </div>
                <p className="leading-relaxed text-mist">
                  第一版请把链接或磁力链直接粘贴到 NDM。Windows 浏览器接管会在完成本机 Relay 后启用。
                </p>
              </div>
            ) : (
            <div className="space-y-3 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-medium text-paper">
                  <Puzzle size={14} strokeWidth={1.5} />
                  <span>浏览器下载接管</span>
                </span>
                <span role="status" data-relay-connection-status className="inline-flex items-center gap-1 text-[12px] font-medium text-fog">
                  {relayPresentation.verified ? <CheckCircle2 size={11} /> : <Radio size={11} />}
                  {relayPresentation.label}
                </span>
              </div>
              {relayPresentation.detail ? <p data-relay-version-hint className="leading-relaxed text-fog">{relayPresentation.detail}</p> : null}
              <p className="leading-relaxed text-mist">
                将浏览器中的文件和视频交给 NDM 下载。
              </p>
              {extensionDir ? (
                <div className="space-y-1.5 border-t border-line/60 pt-3">
                  <div className="flex items-center gap-1.5 text-[14px] font-medium text-paper"><Folder size={14} strokeWidth={1.5} />安装扩展</div>
                  <div className="text-[13px] text-mist">
                    在 Chrome、Arc 或 Edge 的扩展页面开启开发者模式，再选择“加载已解压的扩展程序”。
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      data-cuelume-press
                      onClick={() => void openPath(extensionDir)}
                      className="shrink-0 text-[13px] font-medium text-copper transition-colors hover:text-paper"
                    >
                      打开扩展目录
                    </button>
                    <CopyFeedback copied={extensionPathCopied} error={extensionPathCopyError}
                      onCopy={() => copyExtensionPath(extensionDir, { silent: true })} label="复制目录" />
                  </div>
                </div>
              ) : null}
              <details className="border-t border-line/60 pt-3 text-[13px] text-mist">
                <summary className="cursor-pointer hover:text-paper">连接诊断</summary>
                <div className="mt-3 space-y-2 break-all">
                  <p>本机服务：127.0.0.1:{engineSettings?.bridgePort ?? 51873}</p>
                  {extensionDir ? <p>扩展目录：{extensionDir}</p> : null}
                </div>
              </details>
            </div>
            )}
          </Section>

          <Section title="网站登录" page="extensions">
            <div className="divide-y divide-line/50">
              <div className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0 pr-4">
                  <span className="block text-[14px] font-medium text-paper">登录来源浏览器</span>
                  <span className="block text-[13px] text-mist">需要登录的网站使用此浏览器的登录状态。</span>
                </div>
                <select
                  value={sessionBrowser}
                  onChange={(event) => {
                    const next = event.target.value as SessionBrowser
                    setSessionBrowser(next)
                    writeSessionBrowser(next)
                    cue('tick')
                  }}
                  aria-label="登录墙会话来源浏览器"
                  className="h-8 shrink-0 appearance-none rounded-[8px] border border-line/75 bg-panel/45 px-2.5 pr-6 text-[13px] text-fog outline-none focus:border-copper/55"
                >
                  {SESSION_BROWSER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </Section>

          {/* About / Version Section */}
          <Section title="关于 NDM" page="general">
            <div className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="font-medium text-paper">NDM Desktop</span>
                <span className="font-mono text-[13px] text-copper">v{window.ndm?.version ?? '开发版'}</span>
              </div>
              <div className="flex items-center justify-between text-mist">
                <span>构建版本 (Build)</span>
                <span className="font-mono">{window.ndm?.build ?? '开发版'}</span>
              </div>
              <div className="flex items-center justify-between text-mist">
                <span>下载内核</span>
                <span>{IS_WINDOWS ? 'aria2 + yt-dlp (Windows)' : 'Swift NDMEngine (Native Daemon)'}</span>
              </div>
            </div>
          </Section>
          </div>
        </div>
      </main>
    </Dialog.Popup>
    </Dialog.Portal>
    </Dialog.Root>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[13px]">
      <span className="shrink-0 text-mist">{label}</span>
      <span className="min-w-0 truncate font-mono text-[13px] text-fog" title={value}>
        {value}
      </span>
    </div>
  )
}

function Section({ title, page, children }: { title: string; page: SettingsPage; children: ReactNode }) {
  return (
    <section data-settings-page={page}>
      <div className="mb-3 text-[14px] font-medium text-paper">{title}</div>
      <div className="settings-group">{children}</div>
    </section>
  )
}

function Swatch({ id, selected = false }: { id: ThemeId; selected?: boolean }) {
  const fill = id === 'walnut' ? '#111113' : id === 'dawn' ? '#f7f7f8' : '#ffffff'
  const mark = id === 'walnut' ? '#d4d4d8' : '#52525b'
  return (
    <span
      className={`relative h-10 w-10 shrink-0 overflow-hidden rounded-xl border ${selected ? 'border-accent/70 shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_16%,transparent)]' : 'border-line'}`}
      style={{ background: fill }}
    >
      <span className="absolute inset-x-1 bottom-1 h-1 rounded-full" style={{ background: mark }} />
    </span>
  )
}
