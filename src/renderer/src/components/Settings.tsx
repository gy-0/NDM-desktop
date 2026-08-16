import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, Folder, Puzzle, Radio, Volume2 } from 'lucide-react'
import { cue, setSoundEnabled, soundEnabled } from '../lib/sound'
import { chooseFolder, getEngineSettings, openPath, updateEngineSettings } from '../lib/store'
import { readProgressStyle, writeProgressStyle, type ProgressStyle } from '../lib/presentationPrefs'
import { THEMES, type ThemeId } from '../lib/themes'
import type { EngineSettings } from '../lib/types'

export function Settings({
  open,
  themeId,
  onTheme,
  onClose
}: {
  open: boolean
  themeId: ThemeId
  onTheme: (id: ThemeId) => void
  onClose: () => void
}) {
  const [sound, setSound] = useState(soundEnabled)
  const [engineSettings, setEngineSettings] = useState<EngineSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [extensionDir, setExtensionDir] = useState<string | null>(null)
  const [customBandwidth, setCustomBandwidth] = useState('')
  const [httpProxyText, setHttpProxyText] = useState('')
  const [socksProxyText, setSocksProxyText] = useState('')
  const [progressStyle, setProgressStyle] = useState<ProgressStyle>(readProgressStyle)

  useEffect(() => {
    if (open) {
      void getEngineSettings().then((s) => {
        if (s) {
          setEngineSettings(s)
          const fixed = [0, 1048576, 5242880, 10485760]
          if (!fixed.includes(s.bandwidthLimitBytesPerSecond)) {
            setCustomBandwidth(String(Math.round((s.bandwidthLimitBytesPerSecond / 1048576) * 10) / 10))
          }
          // Controlled proxy fields: an uncontrolled defaultValue mounts before
          // this async load resolves and would show empty on first open.
          setHttpProxyText(s.httpProxyHost ? `${s.httpProxyHost}:${s.httpProxyPort || 8080}` : '')
          setSocksProxyText(s.socksProxyHost ? `${s.socksProxyHost}:${s.socksProxyPort || 1080}` : '')
        }
      })
      void window.ndm?.extensionPath?.().then((dir) => setExtensionDir(dir ?? null))
    }
  }, [open])

  if (!open) return null

  const handleSelectFolder = async (): Promise<void> => {
    const selected = await chooseFolder(engineSettings?.downloadDirectory)
    if (selected && engineSettings) {
      const updated = { ...engineSettings, downloadDirectory: selected }
      setEngineSettings(updated)
      setSaving(true)
      await updateEngineSettings({ downloadDirectory: selected })
      setSaving(false)
      cue('success')
    }
  }

  const handleUpdateConnections = async (conns: number): Promise<void> => {
    if (!engineSettings) return
    const updated = { ...engineSettings, maxConnections: conns }
    setEngineSettings(updated)
    await updateEngineSettings({ maxConnections: conns })
    cue('toggle')
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
                    onClick={handleSelectFolder}
                    className="shrink-0 rounded px-2 py-0.5 text-[11.5px] font-medium text-copper transition-colors hover:bg-line"
                  >
                    {saving ? '保存中...' : '选取...'}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-[12px] border border-line bg-ink/20 px-3 py-2.5">
                <div>
                  <span className="block text-[12.5px] font-medium text-paper">单任务最大连接数</span>
                  <span className="block text-[11.5px] text-mist">多线程分段加速下载</span>
                </div>
                <div className="flex items-center gap-1">
                  {[4, 8, 16, 32].map((num) => (
                    <button
                      key={num}
                      type="button"
                      onClick={() => handleUpdateConnections(num)}
                      className={`rounded-md border px-2 py-0.5 text-[11.5px] transition-colors ${
                        (engineSettings?.maxConnections ?? 32) === num
                          ? 'border-copper bg-copper/15 text-copper'
                          : 'border-line text-mist hover:text-paper'
                      }`}
                    >
                      {num}
                    </button>
                  ))}
                </div>
              </div>

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
                      className={`h-7 whitespace-nowrap rounded-[6px] px-1 text-[10.5px] transition-[color,background-color,box-shadow,scale] duration-100 active:scale-[0.96] ${
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
                      className="min-w-0 flex-1 bg-transparent text-right font-mono text-[10.5px] text-fog outline-none placeholder:text-mist/55"
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
                      className={`h-6 rounded-[5px] px-2 text-[10.5px] transition-[color,background-color,box-shadow,scale] duration-100 active:scale-[0.96] ${
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
                  onClick={handleToggleCategoryFolders}
                  className="relative h-[20px] w-[36px] rounded-full transition-colors duration-200"
                  style={{
                    background: (engineSettings?.useCategoryFolders ?? false) ? 'var(--accent)' : 'var(--line-strong)'
                  }}
                >
                  <span
                    className="absolute top-[2px] left-[2px] size-[16px] rounded-full bg-raised transition-transform duration-200"
                    style={{
                      transform: (engineSettings?.useCategoryFolders ?? false)
                        ? 'translateX(16px)'
                        : 'translateX(0)',
                      transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)'
                    }}
                  />
                </button>
              </label>
            </div>
          </Section>

          {/* Network & Proxy */}
          <Section title="网络与代理">
            <div className="rounded-[12px] border border-line bg-ink/20 p-3 space-y-2.5 text-[12px]">
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-mist">HTTP / HTTPS 代理</span>
                <input
                  value={httpProxyText}
                  onChange={(e) => setHttpProxyText(e.target.value)}
                  onBlur={(e) => {
                    const val = e.target.value.trim()
                    if (!val) {
                      void updateEngineSettings({ httpProxyHost: '' }).then((s) => s && setEngineSettings(s))
                      return
                    }
                    const [h, p] = val.split(':')
                    void updateEngineSettings({ httpProxyHost: h, httpProxyPort: p ? Number(p) : 8080 }).then((s) => s && setEngineSettings(s))
                  }}
                  placeholder="例如 127.0.0.1:7890"
                  className="flex-1 rounded-lg border border-line bg-panel px-2 py-1 font-mono text-[11.5px] text-fog outline-none placeholder:text-mist/50"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-mist">SOCKS5 代理</span>
                <input
                  value={socksProxyText}
                  onChange={(e) => setSocksProxyText(e.target.value)}
                  onBlur={(e) => {
                    const val = e.target.value.trim()
                    if (!val) {
                      void updateEngineSettings({ socksProxyHost: '' }).then((s) => s && setEngineSettings(s))
                      return
                    }
                    const [h, p] = val.split(':')
                    void updateEngineSettings({ socksProxyHost: h, socksProxyPort: p ? Number(p) : 1080 }).then((s) => s && setEngineSettings(s))
                  }}
                  placeholder="例如 127.0.0.1:10808"
                  className="flex-1 rounded-lg border border-line bg-panel px-2 py-1 font-mono text-[11.5px] text-fog outline-none placeholder:text-mist/50"
                />
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
                  onClick={() => {
                    const next = !sound
                    setSound(next)
                    setSoundEnabled(next)
                  }}
                  className="relative h-[20px] w-[36px] rounded-full transition-colors duration-200"
                  style={{ background: sound ? 'var(--accent)' : 'var(--line-strong)' }}
                >
                  <span
                    className="absolute top-[2px] left-[2px] size-[16px] rounded-full bg-raised transition-transform duration-200"
                    style={{
                      transform: sound ? 'translateX(16px)' : 'translateX(0)',
                      transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)'
                    }}
                  />
                </button>
              </label>
              {sound ? (
                <button
                  type="button"
                  onClick={() => cue('success')}
                  className="flex items-center gap-1.5 text-[11.5px] text-copper hover:underline px-1"
                >
                  <Volume2 size={13} />
                  <span>试听提示音</span>
                </button>
              ) : null}
            </div>
          </Section>

          {/* Browser Extension Support */}
          <Section title="浏览器扩展">
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
          </Section>

          {/* About / Version Section */}
          <Section title="关于 NDM">
            <div className="rounded-[12px] border border-line bg-ink/20 p-3 space-y-1.5 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="font-medium text-paper">NDM Desktop</span>
                <span className="font-mono text-[11.5px] text-copper">v2026.8.15</span>
              </div>
              <div className="flex items-center justify-between text-[11.5px] text-mist">
                <span>构建版本 (Build)</span>
                <span className="font-mono text-[11px]">2026081501</span>
              </div>
              <div className="flex items-center justify-between text-[11.5px] text-mist">
                <span>下载内核</span>
                <span>Swift NDMEngine (Native Daemon)</span>
              </div>
            </div>
          </Section>
        </div>
      </aside>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-mist">{title}</div>
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
