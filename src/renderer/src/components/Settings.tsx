import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, Folder, Globe, Info, Volume2 } from 'lucide-react'
import { cue, setSoundEnabled, soundEnabled } from '../lib/sound'
import { chooseFolder, getEngineSettings, updateEngineSettings } from '../lib/store'
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

  useEffect(() => {
    if (open) {
      void getEngineSettings().then((s) => {
        if (s) setEngineSettings(s)
      })
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

  return (
    <div className="absolute inset-0 z-30 flex justify-end bg-ink/40" onClick={onClose}>
      <aside
        className="flex h-full w-[400px] flex-col border-l border-line bg-panel shadow-2xl"
        style={{ animation: 'fade-up 380ms cubic-bezier(0.23,1,0.32,1) both' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-drag flex h-[52px] items-center justify-between border-b border-line/60 px-5">
          <div className="text-[13px] font-medium text-paper">偏好设置</div>
          <button
            type="button"
            className="app-no-drag rounded px-2 py-1 text-[12px] text-mist transition-colors hover:text-paper"
            onClick={onClose}
            data-cuelume-press="droplet"
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
                        (engineSettings?.maxConnections ?? 16) === num
                          ? 'border-copper bg-copper/15 text-copper'
                          : 'border-line text-mist hover:text-paper'
                      }`}
                    >
                      {num}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between rounded-[12px] border border-line bg-ink/20 px-3 py-2.5">
                <div>
                  <span className="block text-[12.5px] font-medium text-paper">全局带宽限速</span>
                  <span className="block text-[11.5px] text-mist">控制全局最大下载速度</span>
                </div>
                <div className="flex items-center gap-1">
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
                        void updateEngineSettings({ bandwidthLimitBytesPerSecond: tier.val }).then((updated) => {
                          if (updated) setEngineSettings(updated)
                        })
                      }}
                      className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                        (engineSettings?.bandwidthLimitBytesPerSecond ?? 0) === tier.val
                          ? 'border-copper bg-copper/15 text-copper'
                          : 'border-line text-mist hover:text-paper'
                      }`}
                    >
                      {tier.label}
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
                  aria-checked={engineSettings?.useCategoryFolders ?? true}
                  data-cuelume-toggle
                  onClick={handleToggleCategoryFolders}
                  className="relative h-[20px] w-[36px] rounded-full transition-colors duration-200"
                  style={{
                    background: (engineSettings?.useCategoryFolders ?? true) ? 'var(--accent)' : 'var(--line-strong)'
                  }}
                >
                  <span
                    className="absolute top-[2px] left-[2px] size-[16px] rounded-full bg-raised transition-transform duration-200"
                    style={{
                      transform: (engineSettings?.useCategoryFolders ?? true)
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
                  defaultValue={engineSettings?.httpProxyHost ? `${engineSettings.httpProxyHost}:${engineSettings.httpProxyPort || 8080}` : ''}
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
                  defaultValue={engineSettings?.socksProxyHost ? `${engineSettings.socksProxyHost}:${engineSettings.socksProxyPort || 1080}` : ''}
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
          <Section title="浏览器集成 (NDM Relay / BetterNDM)">
            <div className="rounded-[12px] border border-line bg-ink/20 p-3 space-y-3 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-fog font-medium">
                  <Globe size={13} className="text-copper" />
                  <span>NDM 专属 WebSocket 桥接端点</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-sage/15 px-2 py-0.5 text-[11px] font-medium text-sage">
                  <CheckCircle2 size={11} /> 127.0.0.1:51873
                </span>
              </div>
              <p className="text-[11.5px] text-mist leading-relaxed">
                NDM Relay (BetterNDM) 专为 NDM 定制，支持自动接管文件下载、嗅探网页视频、解析 YouTube / B站清晰度并提取网页资源架。
              </p>
              <div className="rounded-lg border border-line-strong bg-panel/60 p-2.5 space-y-1.5">
                <div className="text-[11px] font-medium text-copper">📦 本地专属扩展 (NDM Relay)：</div>
                <div className="text-[11px] text-mist">
                  在 Chrome / Arc / Edge 扩展页面打开「开发者模式」，点击「加载已解压的扩展程序」，选择下方目录即可：
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="truncate font-mono text-[10.5px] text-fog">/Users/gaoyuan/NDM/extension/NDMRelay</span>
                  <button
                    type="button"
                    onClick={() => void openPath('/Users/gaoyuan/NDM/extension/NDMRelay')}
                    className="shrink-0 rounded-md border border-line-strong bg-raised px-2.5 py-1 text-[11px] font-medium text-copper hover:bg-copper hover:text-on-accent transition-colors"
                  >
                    打开扩展目录
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-line/40">
                <span className="text-[11px] text-mist">或安装官方商店版：</span>
                <button
                  type="button"
                  onClick={() => void window.ndm?.openExternal?.('https://chromewebstore.google.com/search/neat%20download%20manager')}
                  className="rounded border border-line bg-panel px-2 py-0.5 text-[11px] text-mist hover:text-paper"
                >
                  Chrome 商店 ↗
                </button>
                <button
                  type="button"
                  onClick={() => void window.ndm?.openExternal?.('https://microsoftedge.microsoft.com/addons/search/neat%20download%20manager')}
                  className="rounded border border-line bg-panel px-2 py-0.5 text-[11px] text-mist hover:text-paper"
                >
                  Edge 扩展 ↗
                </button>
                <button
                  type="button"
                  onClick={() => void window.ndm?.openExternal?.('https://addons.mozilla.org/firefox/search/?q=neat%20download%20manager')}
                  className="rounded border border-line bg-panel px-2 py-0.5 text-[11px] text-mist hover:text-paper"
                >
                  Firefox 附加组件 ↗
                </button>
              </div>
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

