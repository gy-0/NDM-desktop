import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, Crown, Folder, Puzzle, Radio, Sparkles, Volume2 } from 'lucide-react'
import { cue, setSoundEnabled, setSoundVolume, soundEnabled, soundVolume } from '../lib/sound'
import { chooseFolder, getEngineSettings, openPath, updateEngineSettings } from '../lib/store'
import { readProgressStyle, writeProgressStyle, type ProgressStyle } from '../lib/presentationPrefs'
import { COMMERCIALIZATION_DRAFT_ENABLED } from '../lib/commercialization'
import { PRO_PRICING, formatActivatedAt, useLicense } from '../lib/license'
import { THEMES, type ThemeId } from '../lib/themes'
import type { EngineSettings } from '../lib/types'
import { CONNECTION_OPTIONS, IS_WINDOWS } from '../lib/platform'
import { activeProxyKind, formatProxyEndpoint, parseProxyEndpoint, type ProxyEndpointError } from '../../../shared/proxyEndpoint'

export function Settings({
  open,
  themeId,
  onTheme,
  onClose,
  onUpgrade,
  onRedeem,
  onReonboard
}: {
  open: boolean
  themeId: ThemeId
  onTheme: (id: ThemeId) => void
  onClose: () => void
  onUpgrade: () => void
  onRedeem: () => void
  onReonboard: () => void
}) {
  const license = useLicense()
  const [sound, setSound] = useState(soundEnabled)
  const [volume, setVolume] = useState(soundVolume)
  const [engineSettings, setEngineSettings] = useState<EngineSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [downloadDirectoryError, setDownloadDirectoryError] = useState('')
  const [savingConnections, setSavingConnections] = useState(false)
  const [downloadSettingsError, setDownloadSettingsError] = useState('')
  const [extensionDir, setExtensionDir] = useState<string | null>(null)
  const [customBandwidth, setCustomBandwidth] = useState('')
  const [httpProxyText, setHttpProxyText] = useState('')
  const [socksProxyText, setSocksProxyText] = useState('')
  const [httpProxyError, setHttpProxyError] = useState('')
  const [socksProxyError, setSocksProxyError] = useState('')
  const [savingHttpProxy, setSavingHttpProxy] = useState(false)
  const [savingSocksProxy, setSavingSocksProxy] = useState(false)
  const [progressStyle, setProgressStyle] = useState<ProgressStyle>(readProgressStyle)
  // t-toggle: `.is-init` gates the double-bounce keyframes until the user's
  // first interaction, so switches don't play their return bounce on mount.
  const [toggleInit, setToggleInit] = useState(false)

  useEffect(() => {
    if (open) {
      let active = true
      let settingsTimer: ReturnType<typeof setTimeout> | undefined
      setDownloadSettingsError('')
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

  if (!open) return null

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
      cue('toggle')
    } catch {
      setDownloadSettingsError('未能保存连接数。请检查下载引擎后重试。')
    } finally {
      setSavingConnections(false)
    }
  }

  const handleToggleCategoryFolders = async (): Promise<void> => {
    if (!engineSettings) return
    const nextVal = !engineSettings.useCategoryFolders
    const updated = { ...engineSettings, useCategoryFolders: nextVal }
    setEngineSettings(updated)
    await updateEngineSettings({ useCategoryFolders: nextVal })
    cue('toggle')
  }

  const handleBandwidth = async (bytesPerSecond: number): Promise<void> => {
    const updated = await updateEngineSettings({ bandwidthLimitBytesPerSecond: Math.max(0, Math.round(bytesPerSecond)) })
    if (updated) setEngineSettings(updated)
    cue('toggle')
  }

  const handleClose = (): void => {
    cue('release')
    onClose()
  }

  const applyCustomBandwidth = (): void => {
    const mb = Number(customBandwidth)
    if (Number.isFinite(mb) && mb > 0) void handleBandwidth(mb * 1048576)
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
      setError(`未能保存${isHTTP ? ' HTTP / HTTPS' : ' SOCKS5'}代理。请检查下载引擎后重试。`)
    } finally {
      setSavingProxy(false)
    }
  }

  const activeProxy = activeProxyKind(engineSettings ?? {})

  return (
    <div className="absolute inset-0 z-30 flex justify-end bg-ink/40" onClick={handleClose}>
      <aside
        className="flex h-full w-[420px] flex-col border-l border-line bg-panel shadow-2xl"
        style={{ animation: 'fade-up 240ms cubic-bezier(0.23,1,0.32,1) both' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-drag flex h-[52px] items-center justify-between border-b border-line/60 px-5">
          <div className="text-[13px] font-medium text-paper">设置</div>
          <button
            type="button"
            className="app-no-drag rounded px-2 py-1 text-[12px] text-mist transition-colors hover:text-paper"
            onClick={handleClose}
          >
            完成
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 scroll-quiet space-y-6">
          {COMMERCIALIZATION_DRAFT_ENABLED ? (
            <Section title="NDM Pro">
              <div className="space-y-3 rounded-[12px] border border-line bg-ink/20 p-3 text-[12px]">
                <div className="flex items-start justify-between gap-3">
                  <span className="flex items-center gap-1.5 font-medium text-paper">
                    <Crown size={14} strokeWidth={1.6} className="text-copper" />
                    <span>{license ? 'NDM Pro' : 'NDM 免费版'}</span>
                  </span>
                  {license ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sage/15 px-2 py-0.5 text-[11px] font-medium text-sage">
                      <CheckCircle2 size={11} /> 已激活
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-line px-2 py-0.5 text-[11px] text-mist">免费档</span>
                  )}
                </div>

                {license ? (
                  <div className="space-y-1.5 rounded-lg bg-panel/55 px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--line)]">
                    <Line label="邮箱" value={license.email || '未记录'} />
                    <Line label="激活码" value={license.key} />
                    <Line label="激活时间" value={formatActivatedAt(license.activatedAt)} />
                    <Line label="授权范围" value={`个人 · 最多 ${PRO_PRICING.seats} 台 Mac`} />
                  </div>
                ) : (
                  <p className="text-[11.5px] leading-relaxed text-mist">
                    免费档已包含多线程加速、断点续传与 Relay 接管。Pro 草案包含播放列表整批下载、4K / 8K、历史云同步与格式转换，
                    {PRO_PRICING.earlyBird} 早鸟一次性买断（原价 {PRO_PRICING.regular}），没有订阅。
                  </p>
                )}

                <div className="flex items-center gap-2 pt-0.5">
                  {license ? (
                    <button type="button" onClick={onUpgrade} className="rounded-md border border-line-strong bg-raised px-2.5 py-1 text-[11px] font-medium text-copper transition-colors hover:bg-copper hover:text-on-accent">
                      查看授权
                    </button>
                  ) : (
                    <>
                      <button type="button" data-cuelume-press data-cuelume-release onClick={onUpgrade} className="inline-flex items-center gap-1 rounded-md bg-copper px-2.5 py-1 text-[11px] font-medium text-on-accent transition-[filter,scale] duration-100 hover:brightness-105 active:scale-[0.96]">
                        <Sparkles size={11} strokeWidth={2} /> 升级
                      </button>
                      <button type="button" onClick={onRedeem} className="rounded-md border border-line-strong bg-raised px-2.5 py-1 text-[11px] text-fog transition-colors hover:text-paper">
                        输入激活码
                      </button>
                    </>
                  )}
                </div>
                <div className="border-t border-line/60 pt-2.5">
                  <button type="button" onClick={onReonboard} className="text-[11px] text-mist underline decoration-line-strong underline-offset-2 transition-colors hover:text-paper">
                    重新查看新手引导
                  </button>
                </div>
              </div>
            </Section>
          ) : (
            <Section title="Beta 计划">
              <div className="space-y-3 rounded-[12px] border border-line bg-ink/20 p-3 text-[12px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-paper">当前版本开放全部已实现能力</span>
                  <span className="shrink-0 rounded-full bg-sage/15 px-2 py-0.5 text-[11px] font-medium text-sage">Beta</span>
                </div>
                <p className="text-[11.5px] leading-relaxed text-mist">
                  免费与 Pro 的边界仍在验证。正式方案确认前，基础下载、合集和清晰度选择都不会被锁住。
                </p>
              <div className="border-t border-line/60 pt-2.5">
                <button
                  type="button"
                  onClick={onReonboard}
                  className="text-[11px] text-copper transition-colors hover:underline"
                >
                  重新引导
                </button>
                <span className="ml-2 text-[10.5px] text-mist">再看一遍首次使用的三步说明</span>
              </div>
            </div>
            </Section>
          )}

          {/* Appearance Section */}
          <Section title="界面外观">
            <p className="mb-3 text-[12px] leading-relaxed text-mist">深色用胡桃夜，浅色用胡桃昼。想更素雅克制，选白昼。</p>
            <div className="grid gap-2">
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  data-cuelume-toggle
                  onClick={() => onTheme(theme.id)}
                  className={`flex items-center gap-3 rounded-[12px] border px-3 py-2.5 text-left transition-[transform,background-color] duration-150 active:scale-[0.98] ${
                    theme.id === themeId ? 'border-line-strong bg-raised shadow-sm' : 'border-line hover:bg-raised/40'
                  }`}
                >
                  <Swatch id={theme.id} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{theme.name}</span>
                    <span className="block text-[12px] text-mist">{theme.line}</span>
                  </span>
                </button>
              ))}
            </div>
          </Section>

          {/* Download Directory & Concurrency */}
          <Section title="下载设置">
            <div className="space-y-3">
              <div className="rounded-[12px] border border-line bg-ink/20 p-3">
                <div className="text-[12.5px] font-medium text-paper">默认保存目录</div>
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5">
                  <Folder size={14} className="shrink-0 text-mist" />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fog"
                    title={engineSettings?.downloadDirectory}
                  >
                    {engineSettings?.downloadDirectory || '正在读取...'}
                  </span>
                  <button
                    type="button"
                    disabled={!engineSettings || saving}
                    aria-busy={saving}
                    aria-describedby={downloadDirectoryError ? 'download-directory-status' : undefined}
                    onClick={handleSelectFolder}
                    className="shrink-0 rounded px-2 py-0.5 text-[11.5px] font-medium text-copper transition-colors hover:bg-line disabled:cursor-wait disabled:opacity-55"
                  >
                    {saving ? '保存中...' : '选取...'}
                  </button>
                </div>
                <p
                  id="download-directory-status"
                  role="status"
                  aria-live="polite"
                  className={downloadDirectoryError ? 'mt-2 text-[11px] text-clay' : 'sr-only'}
                >
                  {downloadDirectoryError}
                </p>
              </div>

              <div className="flex items-center justify-between rounded-[12px] border border-line bg-ink/20 px-3 py-2.5">
                <div>
                  <span className="block text-[12.5px] font-medium text-paper">单任务最大连接数</span>
                  <span className="block text-[11.5px] text-mist">多线程分段加速下载</span>
                </div>
                <div
                  className="flex items-center gap-1"
                  role="group"
                  aria-label="单任务最大连接数"
                  aria-busy={savingConnections}
                  aria-describedby={downloadSettingsError ? 'connection-setting-status' : undefined}
                >
                  {CONNECTION_OPTIONS.map((num) => (
                    <button
                      key={num}
                      type="button"
                      disabled={!engineSettings || savingConnections}
                      aria-pressed={engineSettings?.maxConnections === num}
                      onClick={() => handleUpdateConnections(num)}
                      className={`rounded-md border px-2 py-0.5 text-[11.5px] transition-colors disabled:cursor-wait disabled:opacity-55 ${
                        engineSettings?.maxConnections === num
                          ? 'border-copper bg-copper/15 text-copper'
                          : 'border-line text-mist hover:text-paper'
                      }`}
                    >
                      {num}
                    </button>
                  ))}
                </div>
              </div>
              <p
                id="connection-setting-status"
                role="status"
                aria-live="polite"
                className={downloadSettingsError ? 'px-1 text-[11px] text-clay' : 'sr-only'}
              >
                {downloadSettingsError}
              </p>

              <div className="rounded-[12px] border border-line bg-ink/20 px-3 py-2.5">
                <div>
                  <span className="block text-[12.5px] font-medium text-paper">全局带宽限速</span>
                  <span className="block text-[11.5px] text-mist">控制全局最大下载速度</span>
                </div>
                <div className="mt-2.5 grid grid-cols-[repeat(4,minmax(0,1fr))_minmax(82px,1.35fr)] gap-1 rounded-[9px] bg-panel/70 p-1 shadow-[inset_0_0_0_1px_var(--line)]">
                  {[
                    { label: '不限速', val: 0 },
                    { label: '1 MB/s', val: 1048576 },
                    { label: '5 MB/s', val: 5242880 },
                    { label: '10 MB/s', val: 10485760 }
                  ].map((tier) => (
                    <button
                      key={tier.val}
                      type="button"
                      onClick={() => {
                        void handleBandwidth(tier.val)
                      }}
                      className={`h-7 whitespace-nowrap rounded-[6px] px-1 text-[11.5px] transition-[color,background-color,box-shadow,scale] duration-100 active:scale-[0.96] ${
                        (engineSettings?.bandwidthLimitBytesPerSecond ?? 0) === tier.val
                          ? 'bg-raised font-medium text-copper shadow-[0_0_0_1px_var(--line-strong),0_2px_6px_rgba(0,0,0,0.08)]'
                          : 'text-mist hover:bg-raised/50 hover:text-paper'
                      }`}
                    >
                      {tier.label}
                    </button>
                  ))}
                  <div
                    className={`flex h-7 min-w-0 items-center rounded-[6px] px-1.5 transition-[background-color,box-shadow] duration-100 focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_55%,transparent)] ${
                      ![0, 1048576, 5242880, 10485760].includes(engineSettings?.bandwidthLimitBytesPerSecond ?? 0)
                        ? 'bg-raised shadow-[0_0_0_1px_var(--line-strong)]'
                        : 'bg-ink/15'
                    }`}
                  >
                    <input
                      value={customBandwidth}
                      onChange={(event) => setCustomBandwidth(event.target.value.replace(/[^0-9.]/g, ''))}
                      onBlur={applyCustomBandwidth}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          applyCustomBandwidth()
                          event.currentTarget.blur()
                        }
                      }}
                      inputMode="decimal"
                      aria-label="自定义全局带宽，每秒 MB"
                      placeholder="自定义"
                      className="min-w-0 flex-1 bg-transparent text-right font-mono text-[11.5px] text-fog outline-none placeholder:text-mist/55"
                    />
                    <span className="ml-1 whitespace-nowrap text-[9px] text-mist">MB/s</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-[12px] border border-line bg-ink/20 px-3 py-2.5">
                <div>
                  <span className="block text-[12.5px] font-medium text-paper">下载进度样式</span>
                  <span className="block text-[11.5px] text-mist">分段模式展示真实并行传输</span>
                </div>
                <div className="grid grid-cols-2 gap-1 rounded-[8px] bg-panel/70 p-1 shadow-[inset_0_0_0_1px_var(--line)]">
                  {([
                    ['continuous', '连续'],
                    ['segmented', '分段']
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setProgressStyle(value)
                        writeProgressStyle(value)
                        cue('toggle')
                      }}
                      className={`h-7 rounded-[5px] px-2 text-[11.5px] transition-[color,background-color,box-shadow,scale] duration-100 active:scale-[0.96] ${
                        progressStyle === value
                          ? 'bg-raised font-medium text-copper shadow-[0_0_0_1px_var(--line-strong)]'
                          : 'text-mist'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center justify-between rounded-[12px] border border-line bg-ink/20 px-3 py-2.5">
                <div>
                  <span className="block text-[12.5px] font-medium text-paper">按文件类型分类保存</span>
                  <span className="block text-[11.5px] text-mist">自动将视频/音频/文档归类到对应子目录</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={engineSettings?.useCategoryFolders ?? false}
                  data-cuelume-toggle
                  data-on={(engineSettings?.useCategoryFolders ?? false) ? 'true' : 'false'}
                  className={`t-toggle relative h-[20px] w-[36px] rounded-full transition-colors duration-200 ${toggleInit ? 'is-init' : ''}`}
                  style={{
                    background: (engineSettings?.useCategoryFolders ?? false) ? 'var(--accent)' : 'var(--line-strong)'
                  }}
                  onClick={() => {
                    setToggleInit(true)
                    handleToggleCategoryFolders()
                  }}
                >
                  <span className="t-toggle-thumb absolute top-[2px] left-[2px] size-[16px] rounded-full bg-raised" />
                </button>
              </label>
            </div>
          </Section>

          {/* Network & Proxy */}
          <Section title="网络与代理">
            <div className="rounded-[12px] border border-line bg-ink/20 p-3 space-y-2.5 text-[12px]">
              <p className="text-[10.5px] leading-4 text-mist">同一时间只使用一种代理；保存另一项时会自动切换。</p>
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex shrink-0 items-center gap-1.5">
                    <label htmlFor="http-proxy" className="text-mist">HTTP / HTTPS 代理</label>
                    {engineSettings?.httpProxyHost ? (
                      <span data-proxy-state="http" className={`text-[9.5px] ${activeProxy === 'http' ? 'text-copper' : 'text-mist/70'}`}>
                        {activeProxy === 'http' ? '使用中' : '已保存'}
                      </span>
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
                    className="flex-1 rounded-lg border border-line bg-panel px-2 py-1 font-mono text-[11.5px] text-fog outline-none placeholder:text-mist/50 aria-[invalid=true]:border-clay disabled:opacity-60"
                  />
                </div>
                <p id="http-proxy-error" role="status" aria-live="polite" className={`mt-1 min-h-[16px] text-right text-[10.5px] leading-4 text-clay ${httpProxyError ? 'visible' : 'invisible'}`}>
                  {httpProxyError}
                </p>
              </div>
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex shrink-0 items-center gap-1.5">
                    <label htmlFor="socks-proxy" className="text-mist">SOCKS5 代理</label>
                    {engineSettings?.socksProxyHost ? (
                      <span data-proxy-state="socks" className={`text-[9.5px] ${activeProxy === 'socks' ? 'text-copper' : 'text-mist/70'}`}>
                        {activeProxy === 'socks' ? '使用中' : '已保存'}
                      </span>
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
                    className="flex-1 rounded-lg border border-line bg-panel px-2 py-1 font-mono text-[11.5px] text-fog outline-none placeholder:text-mist/50 aria-[invalid=true]:border-clay disabled:opacity-60"
                  />
                </div>
                <p id="socks-proxy-error" role="status" aria-live="polite" className={`mt-1 min-h-[16px] text-right text-[10.5px] leading-4 text-clay ${socksProxyError ? 'visible' : 'invisible'}`}>
                  {socksProxyError}
                </p>
              </div>
            </div>
          </Section>

          {/* Sound & Audio Effects */}
          <Section title="声音与反馈">
            <div className="space-y-2">
              <label className="flex items-center justify-between rounded-[12px] border border-line px-3 py-2.5">
                <span>
                  <span className="block text-[12.5px] font-medium text-paper">操作提示音</span>
                  <span className="block text-[11.5px] text-mist">点击、完成与状态切换时发出轻声反馈</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={sound}
                  data-cuelume-toggle
                  data-on={sound ? 'true' : 'false'}
                  className={`t-toggle relative h-[20px] w-[36px] rounded-full transition-colors duration-200 ${toggleInit ? 'is-init' : ''}`}
                  style={{ background: sound ? 'var(--accent)' : 'var(--line-strong)' }}
                  onClick={() => {
                    setToggleInit(true)
                    const next = !sound
                    setSound(next)
                    setSoundEnabled(next)
                  }}
                >
                  <span className="t-toggle-thumb absolute top-[2px] left-[2px] size-[16px] rounded-full bg-raised" />
                </button>
              </label>
              {sound ? (
                <div className="rounded-[10px] border border-line px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-[12px] text-fog">
                      <Volume2 size={14} />
                      提示音音量
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-mist">{Math.round(volume * 100)}%</span>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <input
                      type="range"
                      min="20"
                      max="100"
                      step="5"
                      value={Math.round(volume * 100)}
                      onChange={(event) => {
                        const next = Number(event.target.value) / 100
                        setVolume(next)
                        setSoundVolume(next)
                      }}
                      aria-label="提示音音量"
                      className="h-1 flex-1 cursor-pointer accent-copper"
                    />
                    <button
                      type="button"
                      onClick={() => cue('success')}
                      className="shrink-0 rounded-[7px] px-2 py-1 text-[11.5px] text-copper transition-[background-color,scale] duration-100 hover:bg-copper/10 active:scale-[0.96]"
                    >
                      试听
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </Section>

          {/* Browser Extension Support */}
          <Section title="浏览器扩展">
            {IS_WINDOWS ? (
              <div className="rounded-[12px] border border-line bg-ink/20 p-3 space-y-2 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-medium text-fog">
                    <Puzzle size={14} strokeWidth={1.5} className="text-copper" />
                    Windows Relay
                  </span>
                  <span className="rounded-full bg-clay/12 px-2 py-0.5 text-[11px] text-clay">后续版本</span>
                </div>
                <p className="text-[11.5px] leading-relaxed text-mist">
                  第一版请把链接或磁力链直接粘贴到 NDM。Windows 浏览器接管会在完成本机 Relay 后启用。
                </p>
              </div>
            ) : (
            <div className="rounded-[12px] border border-line bg-ink/20 p-3 space-y-3 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-fog font-medium">
                  <Puzzle size={14} strokeWidth={1.5} className="text-copper" />
                  <span>NDM Relay</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-sage/15 px-2 py-0.5 text-[11px] font-medium text-sage">
                  <CheckCircle2 size={11} /> 本地可用
                </span>
              </div>
              <p className="text-[11.5px] text-mist leading-relaxed">
                安装本地扩展后，浏览器可将下载链接和网页视频直接交给 NDM。
              </p>
              <div className="flex items-center justify-between rounded-lg bg-panel/55 px-2.5 py-2 text-[10.5px] text-mist shadow-[inset_0_0_0_1px_var(--line)]">
                <span className="flex items-center gap-1.5"><Radio size={12} strokeWidth={1.5} />本机桥接</span>
                <span className="font-mono tabular-nums text-fog">127.0.0.1:{engineSettings?.bridgePort ?? 51873}</span>
              </div>
              {extensionDir ? (
                <div className="rounded-lg border border-line-strong bg-panel/60 p-2.5 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-paper"><Folder size={12} strokeWidth={1.5} className="text-copper" />本地扩展</div>
                  <div className="text-[11px] text-mist">
                    在 Chrome、Arc 或 Edge 的扩展页面开启开发者模式，再选择“加载已解压的扩展程序”。
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="truncate font-mono text-[10.5px] text-fog" title={extensionDir}>
                      {extensionDir}
                    </span>
                    <button
                      type="button"
                      onClick={() => void openPath(extensionDir)}
                      className="shrink-0 rounded-md border border-line-strong bg-raised px-2.5 py-1 text-[11px] font-medium text-copper hover:bg-copper hover:text-on-accent transition-colors"
                    >
                      打开扩展目录
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            )}
          </Section>

          {/* About / Version Section */}
          <Section title="关于 NDM">
            <div className="rounded-[12px] border border-line bg-ink/20 p-3 space-y-1.5 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="font-medium text-paper">NDM Desktop</span>
                <span className="font-mono text-[11.5px] text-copper">v2026.8.17</span>
              </div>
              <div className="flex items-center justify-between text-[11.5px] text-mist">
                <span>构建版本 (Build)</span>
                <span className="font-mono text-[11px]">2026081701</span>
              </div>
              <div className="flex items-center justify-between text-[11.5px] text-mist">
                <span>下载内核</span>
                <span>{IS_WINDOWS ? 'aria2 + yt-dlp (Windows)' : 'Swift NDMEngine (Native Daemon)'}</span>
              </div>
            </div>
          </Section>
        </div>
      </aside>
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[11px]">
      <span className="shrink-0 text-mist">{label}</span>
      <span className="min-w-0 truncate font-mono text-[10.5px] text-fog" title={value}>
        {value}
      </span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-mist">{title}</div>
      {children}
    </section>
  )
}

function Swatch({ id }: { id: ThemeId }) {
  const fill = id === 'walnut' ? '#141210' : id === 'dawn' ? '#f4efe6' : '#f5f4f0'
  const mark = id === 'noon' ? '#2a4a7a' : '#d08a3a'
  return (
    <span className="relative h-10 w-10 overflow-hidden rounded-[10px] border border-line" style={{ background: fill }}>
      <span className="absolute inset-x-1 bottom-1 h-1 rounded-full" style={{ background: mark }} />
    </span>
  )
}
