import { Dialog } from '@base-ui/react/dialog'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleCheck, Clapperboard, FolderOpen, Link2, LockKeyhole, Pause, Play, Puzzle, RotateCcw, Globe, type LucideIcon } from 'lucide-react'
import { TransferField } from '../effects/metalforge/ProductMotion'
import { SmoothProgressBar } from './SmoothProgressBar'
import { TypeMark } from './Marks'
import { Wordmark } from './Wordmark'
import { ThemePreviewCard, CategoryHueStrip } from './ThemePreview'
import { RelayInstallPanel } from './RelayInstallPanel'
import { cue } from '../lib/sound'
import { FILE_MANAGER, IS_WINDOWS } from '../lib/platform'
import { describeRelayStatus, parseRelayBridgeStatus, type RelayBridgeStatus } from '../lib/relayStatus'
import { THEMES, type ThemeId } from '../lib/themes'
import type { DownloadCategory } from '../lib/types'
import './ui/completion-pocket.css'
import './ui/onboarding.css'

type Step = 'welcome' | 'features' | 'appearance' | 'browser'
type Scene = 'paste' | 'relay' | 'media' | 'tray'

const SCENES: ReadonlyArray<{ id: Scene; label: string; icon: LucideIcon; title: string; lead: string }> = [
  { id: 'paste', label: '粘贴即下载', icon: Link2, title: '粘贴一个链接，\n剩下的交给 NDM。', lead: '文件、视频网址或分享口令。多线程加速，随时暂停，从原处继续。' },
  { id: 'relay', label: '浏览器接力', icon: Puzzle, title: '在浏览器里发现，\n在 NDM 里完成。', lead: '装上 NDM Relay，网页里的下载和视频会自动交给 NDM，登录状态一并带过来。' },
  { id: 'media', label: '网页视频', icon: Clapperboard, title: '网页视频，\n挑一个清晰度就好。', lead: '识别页面里的视频与音频，列出可选版本，直播也能录。' },
  { id: 'tray', label: '完成即带走', icon: FolderOpen, title: '下载完成，\n顺手带走。', lead: '最近完成的文件在托盘里排好，直接拖进别的 App，空格就能预览。' }
]

export function Onboarding({ open, onFinish, onClosed, themeId, onTheme }: {
  open: boolean
  onFinish: (intent?: 'download') => void
  onClosed?: () => void
  themeId: ThemeId
  onTheme: (id: ThemeId) => void
}) {
  const steps: Step[] = IS_WINDOWS ? ['welcome', 'features', 'appearance'] : ['welcome', 'features', 'appearance', 'browser']
  const [step, setStep] = useState<Step>('welcome')
  const [scene, setScene] = useState<Scene>('paste')
  const heading = useRef<HTMLHeadingElement>(null)
  const downloadIntent = useRef(false)
  const reduced = useReducedMotion()
  const index = steps.indexOf(step)
  const last = index === steps.length - 1

  useEffect(() => { if (open) { downloadIntent.current = false; setStep('welcome'); setScene('paste') } }, [open])

  const finish = (intent?: 'download'): void => {
    downloadIntent.current = intent === 'download'
    onFinish(intent)
  }
  const navigate = (next: Step): void => {
    setStep(next)
    cue('page')
  }

  return (
    <Dialog.Root open={open} onOpenChangeComplete={next => { if (!next) onClosed?.() }} onOpenChange={(next, details) => {
      // A stray click around the welcome surface should not dismiss setup.
      if (!next && details.reason !== 'outside-press') finish()
    }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="onboarding-backdrop" />
        <Dialog.Viewport className="onboarding-viewport">
          <Dialog.Popup className="onboarding-dialog" aria-label="欢迎使用 NDM" aria-describedby={undefined}
            initialFocus={heading} finalFocus={() => downloadIntent.current ? false : document.getElementById('ndm-search')}>
            <Dialog.Title className="sr-only">欢迎使用 NDM</Dialog.Title>
            <header className="onboarding-header">
              {step !== 'welcome' ? <Wordmark size={26} reveal={false} /> : <span className="onboarding-brand-slot" aria-hidden />}
              <span className="onboarding-eyebrow">{step === 'welcome' ? '欢迎使用' : step === 'features' ? 'NDM 能做什么' : step === 'appearance' ? '选一个外观' : '浏览器连接'}</span>
              <button type="button" onClick={() => finish()} className="onboarding-skip">跳过</button>
            </header>
            <div className="onboarding-pages">
              <AnimatePresence mode="wait" initial={false}>
                <motion.section key={step} data-onboarding-step={step} className="onboarding-page" data-layout={step === 'welcome' ? 'welcome' : step === 'appearance' ? 'stack' : 'split'}
                  initial={{ opacity: 0, x: reduced ? 0 : 10 }}
                  animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : -6 }}
                  transition={{ duration: reduced ? 0 : 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                  onAnimationComplete={() => heading.current?.focus({ preventScroll: true })}>
                  {step === 'welcome' ? <WelcomeStep heading={heading} /> : null}
                  {step === 'features' ? <FeaturesStep heading={heading} scene={scene} onScene={next => { setScene(next); cue('tick') }} onNew={() => finish('download')} /> : null}
                  {step === 'appearance' ? <AppearanceStep heading={heading} themeId={themeId} onTheme={onTheme} /> : null}
                  {step === 'browser' ? <BrowserSetup heading={heading} /> : null}
                </motion.section>
              </AnimatePresence>
            </div>
            <footer className="onboarding-footer">
              {index > 0 ? <button type="button" className="onboarding-secondary" onClick={() => navigate(steps[index - 1])}><ArrowLeft size={16} aria-hidden />返回</button>
                : <p className="onboarding-privacy"><LockKeyhole size={14} aria-hidden />任务记录保存在本机</p>}
              <ol className="onboarding-steps" aria-label="引导进度">
                {steps.map((item, position) => <li key={item} aria-current={item === step ? 'step' : undefined}>
                  <button type="button" aria-label={`第 ${position + 1} 步`} onClick={() => navigate(item)} />
                </li>)}
              </ol>
              <div className="onboarding-footer-actions">
                {!last ? <button type="button" data-onboarding-next className="onboarding-secondary" onClick={() => navigate(steps[index + 1])}>{step === 'welcome' ? '看看能做什么' : '下一步'}<ArrowRight size={15} aria-hidden /></button> : null}
                <button type="button" data-onboarding-finish className="onboarding-primary" onClick={() => { cue('page'); finish('download') }}>添加第一个下载<ArrowRight size={16} aria-hidden /></button>
              </div>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function WelcomeStep({ heading }: { heading: React.RefObject<HTMLHeadingElement | null> }) {
  return <div className="onboarding-welcome">
    <Wordmark size={96} className="onboarding-welcome-mark" />
    <h2 ref={heading} tabIndex={-1}>下载，由你掌控。</h2>
    <p className="onboarding-lead">文件、视频与网页链接，都在一个安静的工作区。</p>
    <ul className="onboarding-welcome-hues" aria-hidden>
      {(['video', 'audio', 'document', 'compressed', 'application', 'image'] as DownloadCategory[]).map((category, position) => (
        <li key={category} data-category={category} style={{ '--i': position } as CSSProperties} />
      ))}
    </ul>
  </div>
}

function FeaturesStep({ heading, scene, onScene, onNew }: { heading: React.RefObject<HTMLHeadingElement | null>; scene: Scene; onScene: (scene: Scene) => void; onNew: () => void }) {
  const current = SCENES.find(item => item.id === scene) ?? SCENES[0]
  const reduced = useReducedMotion()
  const sceneButtons = useRef<Partial<Record<Scene, HTMLButtonElement | null>>>({})
  return <>
    <div className="onboarding-intro">
      <div role="tablist" aria-label="功能场景" className="onboarding-scenes">
        {SCENES.map(item => {
          const Icon = item.icon
          return <button key={item.id} role="tab" type="button" aria-selected={item.id === scene} id={`onboarding-scene-${item.id}`}
            ref={element => { sceneButtons.current[item.id] = element }} tabIndex={item.id === scene ? 0 : -1}
            onKeyDown={event => {
              const position = SCENES.findIndex(candidate => candidate.id === item.id)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? SCENES.length - 1
                : event.key === 'ArrowRight' ? (position + 1) % SCENES.length
                  : event.key === 'ArrowLeft' ? (position + SCENES.length - 1) % SCENES.length : null
              if (next === null) return
              event.preventDefault()
              onScene(SCENES[next].id)
              sceneButtons.current[SCENES[next].id]?.focus()
            }}
            aria-controls="onboarding-scene-panel" onClick={() => onScene(item.id)}>
            <Icon size={14} aria-hidden />{item.label}
          </button>
        })}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={scene} initial={{ opacity: 0, y: reduced ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.16 }}>
          <h2 ref={heading} tabIndex={-1}>{current.title.split('\n').map((line, position) => <span key={position}>{line}<br /></span>)}</h2>
          <p className="onboarding-lead">{current.lead}</p>
        </motion.div>
      </AnimatePresence>
    </div>
    <div id="onboarding-scene-panel" role="tabpanel" tabIndex={0} aria-labelledby={`onboarding-scene-${scene}`} className="onboarding-experience">
      {scene === 'paste' ? <DownloadDemo onNew={onNew} /> : null}
      {scene === 'relay' ? <RelayDemo /> : null}
      {scene === 'media' ? <MediaDemo /> : null}
      {scene === 'tray' ? <TrayDemo /> : null}
    </div>
  </>
}

function AppearanceStep({ heading, themeId, onTheme }: { heading: React.RefObject<HTMLHeadingElement | null>; themeId: ThemeId; onTheme: (id: ThemeId) => void }) {
  return <div className="onboarding-appearance-step">
    <div className="onboarding-intro">
      <h2 ref={heading} tabIndex={-1}>选一个舒服的外观。</h2>
      <p className="onboarding-lead">随时可以在设置里更改。冷蓝标记操作与选中，文件类型各有一色。</p>
    </div>
    <div role="group" aria-label="外观" className="theme-cards onboarding-theme-cards">
      {THEMES.map(theme => <ThemePreviewCard key={theme.id} theme={theme} selected={theme.id === themeId} onSelect={() => { onTheme(theme.id); cue('toggle') }} />)}
    </div>
    <CategoryHueStrip />
  </div>
}

function DownloadDemo({ onNew }: { onNew: () => void }) {
  const [progress, setProgress] = useState(0.24)
  const [phase, setPhase] = useState<'ready' | 'running' | 'paused' | 'complete'>('ready')
  const [cycle, setCycle] = useState(0)
  const reduced = useReducedMotion()
  useEffect(() => {
    if (phase !== 'running') return
    const timer = window.setInterval(() => setProgress(current => Math.min(1, current + 0.012)), 160)
    return () => window.clearInterval(timer)
  }, [phase])
  useEffect(() => { if (progress >= 1 && phase === 'running') setPhase('complete') }, [progress, phase])
  const complete = phase === 'complete'
  const active = phase === 'running'
  const toggle = (): void => {
    if (complete) { setProgress(0.24); setCycle(current => current + 1); setPhase('running') }
    else setPhase(active ? 'paused' : 'running')
    cue('press')
  }
  const label = complete ? '重新演示' : active ? '暂停演示' : phase === 'paused' ? '继续演示' : '开始演示'
  const Icon = complete ? RotateCcw : active ? Pause : Play
  return <div className="onboarding-demo" data-onboarding-demo data-demo-phase={phase}>
    <div className="onboarding-demo-caption"><span>交互演示</span><span>试着暂停，再继续</span></div>
    <div className="onboarding-transfer-card">
      {!reduced && !complete ? <TransferField progressFraction={progress} active={active} identity={`onboarding-${cycle}`} /> : null}
      <div className="onboarding-transfer-content">
        <div className="onboarding-file-heading"><TypeMark category="compressed" size="lg" /><div><strong>设计素材.zip</strong><span>{complete ? '已完成，随时可用' : phase === 'paused' ? '已暂停，进度已保留' : '压缩包 · 下载演示'}</span></div></div>
        <div className="onboarding-transfer-status" aria-live="polite"><span>{complete ? <><CircleCheck size={15} aria-hidden />已完成</> : phase === 'paused' ? '已暂停' : active ? '正在下载' : '准备好了'}</span><span aria-hidden className="tabular-nums">{Math.round(progress * 100)}%</span></div>
        <SmoothProgressBar fraction={progress} active={active && !reduced} fillClassName="onboarding-demo-fill" trackClassName="onboarding-demo-track" />
        <div className="onboarding-demo-actions"><span>{complete ? '空格预览 · 拖到其他 App' : '暂停后，从原处继续'}</span><button type="button" onClick={toggle} aria-label={label}><Icon size={15} aria-hidden />{complete ? '再试一次' : active ? '暂停' : phase === 'paused' ? '继续' : '试一下'}</button></div>
      </div>
    </div>
    <div className="onboarding-demo-footnote"><span>演示不会下载文件</span><button type="button" onClick={onNew}>添加自己的下载<ArrowRight size={13} aria-hidden /></button></div>
  </div>
}

/** The browser hands a page to NDM: one dot travels the wire, once per cycle. */
function RelayDemo() {
  return <div className="onboarding-demo" aria-hidden>
    <div className="onboarding-demo-caption"><span>浏览器接力</span><span>NDM Relay</span></div>
    <div className="onboarding-relay">
      <div className="onboarding-relay-browser">
        <span className="onboarding-relay-dots"><i /><i /><i /></span>
        <span className="onboarding-relay-url"><Globe size={11} />example.com/release/Nord-Brand-system.zip</span>
        <span className="onboarding-relay-badge"><Puzzle size={11} />Relay</span>
      </div>
      <div className="onboarding-relay-wire"><i /></div>
      <div className="onboarding-relay-ndm">
        <Wordmark size={16} reveal={false} />
        <span className="onboarding-relay-task" data-category="compressed">
          <TypeMark category="compressed" size="sm" />
          <span className="onboarding-relay-task-text"><strong>Nord — Brand system.zip</strong><small>已接力 · 带登录状态</small></span>
          <Check size={14} />
        </span>
      </div>
    </div>
    <div className="onboarding-demo-footnote"><span>只在你点下载时接力，不监听浏览记录。</span></div>
  </div>
}

/** A page's media, resolved into pickable versions. */
function MediaDemo() {
  const versions = [
    { label: '2160p', size: '1.9 GB', pro: true },
    { label: '1080p', size: '640 MB', selected: true },
    { label: '720p', size: '318 MB' },
    { label: '仅音频', size: '42 MB' }
  ]
  return <div className="onboarding-demo" aria-hidden>
    <div className="onboarding-demo-caption"><span>网页视频</span><span>识别版本后再下载</span></div>
    <div className="onboarding-media">
      <div className="onboarding-media-poster" data-category="video">
        <Clapperboard size={26} strokeWidth={1.3} />
        <span>Interface studies · 12:40</span>
      </div>
      <ul className="onboarding-media-versions">
        {versions.map(version => <li key={version.label} data-selected={version.selected || undefined}>
          <span>{version.label}</span><small>{version.size}</small>{version.selected ? <Check size={13} /> : null}
        </li>)}
      </ul>
    </div>
    <div className="onboarding-demo-footnote"><span>直播也可以录制，边播边存。</span></div>
  </div>
}

/** The real tray styling with placeholder sheets; hover fans them. */
function TrayDemo() {
  const sheets: Array<{ type: string; category: DownloadCategory; name: string }> = [
    { type: 'ZIP', category: 'compressed', name: 'Nord — Brand system.zip' },
    { type: 'MP4', category: 'video', name: 'Interface studies.mp4' },
    { type: 'PDF', category: 'document', name: 'Field Notes.pdf' },
    { type: 'FLAC', category: 'audio', name: 'Ambient recordings.flac' },
    { type: 'PNG', category: 'image', name: 'Poster.png' }
  ]
  const positions = [0, -1, 1, -2, 2]
  return <div className="onboarding-demo" aria-hidden>
    <div className="onboarding-demo-caption"><span>完成即带走</span><span>把鼠标移到托盘上</span></div>
    <div className="onboarding-tray">
      <div className="completion-pocket-stage onboarding-tray-stage">
        <span className="completion-pocket-back" />
        {sheets.map((sheet, position) => <span key={sheet.type} className="completion-pocket-paper" data-category={sheet.category}
          style={{ '--pocket-position': positions[position], '--pocket-depth': Math.abs(positions[position]), zIndex: 8 - position } as CSSProperties}>
          <span className="completion-pocket-paper-type">{sheet.type}</span>
          <span className="completion-pocket-artwork" data-artwork="type"><TypeMark category={sheet.category} size="sm" /></span>
          <span className="completion-pocket-paper-name">{sheet.name}</span>
        </span>)}
        <span className="completion-pocket-front"><FolderOpen size={17} strokeWidth={1.35} /><span>最近文件</span><span className="completion-pocket-front-count">05</span></span>
        <span className="completion-pocket-shadow" />
      </div>
    </div>
    <div className="onboarding-demo-footnote"><span>{`拖进邮件、聊天或${FILE_MANAGER}；空格快速预览。`}</span></div>
  </div>
}

function BrowserSetup({ heading }: { heading: React.RefObject<HTMLHeadingElement | null> }) {
  const [status, setStatus] = useState<RelayBridgeStatus | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const reply = await window.ndm?.request('getBridgeStatus')
        const parsed = parseRelayBridgeStatus(reply)
        if (alive) {
          setStatus(parsed); setStatusFailed(false)
        }
      } catch { if (alive) { setStatus(null); setStatusFailed(true) } }
      finally { if (alive) timer = setTimeout(() => { void refresh() }, 1800) }
    }
    void refresh()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])
  const presentation = describeRelayStatus(status, statusFailed)
  return <>
    <div className="onboarding-intro">
      <h2 ref={heading} tabIndex={-1}>在浏览器里发现，<br />交给 NDM 下载。</h2>
      <p className="onboarding-lead">连接扩展后，网页中的文件与视频<br />可以直接交给 NDM。</p>
      {!presentation.verified ? <p className="onboarding-optional">这一步可以稍后完成。<br />现在就能粘贴链接开始下载。</p> : null}
    </div>
    <div className="onboarding-browser-card">
      <div className="onboarding-connection" data-onboarding-relay-status data-verified={presentation.verified}>
        <span className="onboarding-connection-icon">{presentation.verified ? <Check size={22} aria-hidden /> : <Puzzle size={22} aria-hidden />}</span>
        <div><strong>{presentation.verified ? '浏览器已连接' : '连接你的浏览器'}</strong><span role="status">{presentation.verified ? '准备好接收下载了' : presentation.label}</span></div>
      </div>
      {presentation.verified ? <div className="onboarding-ready">
        <p>在浏览器中下载文件，或通过扩展保存网页视频。任务会出现在 NDM 中。</p>
        <span>连接可随时在设置中管理。</span>
      </div> : <div className="p-4">
        {presentation.detail ? <p className="mb-3 text-[13px] text-fog">{presentation.detail}</p> : null}
        <RelayInstallPanel />
      </div>}

    </div>
  </>
}
