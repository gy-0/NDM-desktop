import { Dialog } from '@base-ui/react/dialog'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleCheck, FolderOpen, Link2, LockKeyhole, Moon, Pause, Play, Puzzle, RotateCcw, Sun, SunDim } from 'lucide-react'
import { TransferField } from '../effects/metalforge/ProductMotion'
import { SmoothProgressBar } from './SmoothProgressBar'
import { TypeMark } from './Marks'
import { openPath } from '../lib/store'
import { cue } from '../lib/sound'
import { FILE_MANAGER, IS_WINDOWS } from '../lib/platform'
import { describeRelayStatus, parseRelayBridgeStatus, type RelayBridgeStatus } from '../lib/relayStatus'
import { THEMES, type ThemeId } from '../lib/themes'
import './ui/onboarding.css'

export function Onboarding({ open, onFinish, themeId, onTheme }: {
  open: boolean
  onFinish: (intent?: 'download') => void
  themeId: ThemeId
  onTheme: (id: ThemeId) => void
}) {
  const [step, setStep] = useState<'welcome' | 'browser'>('welcome')
  const heading = useRef<HTMLHeadingElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => { if (open) setStep('welcome') }, [open])

  const finish = (intent?: 'download'): void => {
    onFinish(intent)
  }
  const navigate = (next: 'welcome' | 'browser'): void => {
    setStep(next)
    cue('page')
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next, details) => {
      // A stray click around the welcome surface should not dismiss setup.
      if (!next && details.reason !== 'outside-press') finish()
    }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="onboarding-backdrop" />
        <Dialog.Viewport className="onboarding-viewport">
          <Dialog.Popup className="onboarding-dialog" aria-label="欢迎使用 NDM" aria-describedby={undefined}
            initialFocus={heading} finalFocus={() => document.getElementById('ndm-search')}>
            <Dialog.Title className="sr-only">欢迎使用 NDM</Dialog.Title>
            <header className="onboarding-header">
              <span className="onboarding-brand" aria-hidden>NDM</span>
              <span className="onboarding-eyebrow">{step === 'welcome' ? '欢迎使用' : '浏览器连接'}</span>
              <button type="button" onClick={() => finish()} className="onboarding-skip">跳过</button>
            </header>
            <div className="onboarding-pages">
              <AnimatePresence mode="wait" initial={false}>
                <motion.section key={step} data-onboarding-step={step} className="onboarding-page"
                  initial={{ opacity: 0, x: reduced ? 0 : step === 'welcome' ? -8 : 8 }}
                  animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                  transition={{ duration: reduced ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                  onAnimationComplete={() => heading.current?.focus({ preventScroll: true })}>
                  {step === 'welcome' ? <>
                    <div className="onboarding-intro">
                      <h2 ref={heading} tabIndex={-1}>下载，<br />由你掌控。</h2>
                      <p className="onboarding-lead">文件、视频与网页链接，<br />都在一个安静的工作区。</p>
                      <div className="onboarding-benefits">
                        <p><Link2 size={17} aria-hidden />粘贴链接，就能开始</p>
                        <p><Pause size={17} aria-hidden />随时暂停，从原处继续</p>
                        <p><FolderOpen size={17} aria-hidden />下载完成，顺手带走</p>
                      </div>
                    </div>
                    <div className="onboarding-experience">
                      <DownloadDemo onNew={() => finish('download')} />
                      <div className="onboarding-appearance">
                        <span>选一个舒服的外观</span>
                        <div role="group" aria-label="外观" className="onboarding-themes">
                          {THEMES.map(theme => {
                            const Icon = theme.id === 'walnut' ? Moon : theme.id === 'dawn' ? SunDim : Sun
                            return <button type="button" key={theme.id} aria-label={`使用${theme.name}`}
                              aria-pressed={themeId === theme.id} onClick={() => { onTheme(theme.id); cue('toggle') }}>
                              <Icon size={15} aria-hidden /><span>{theme.name}</span>
                            </button>
                          })}
                        </div>
                      </div>
                    </div>
                  </> : <BrowserSetup heading={heading} />}
                </motion.section>
              </AnimatePresence>
            </div>
            <footer className="onboarding-footer">
              {step === 'browser' ? <button type="button" className="onboarding-secondary" onClick={() => navigate('welcome')}><ArrowLeft size={16} aria-hidden />返回</button>
                : <p className="onboarding-privacy"><LockKeyhole size={14} aria-hidden />任务记录保存在本机</p>}
              <div className="onboarding-footer-actions">
                {step === 'welcome' && !IS_WINDOWS ? <button type="button" className="onboarding-secondary" onClick={() => navigate('browser')}>连接浏览器<ArrowRight size={15} aria-hidden /></button> : null}
                <button type="button" data-onboarding-finish className="onboarding-primary" onClick={() => { cue('page'); finish() }}>开始使用<ArrowRight size={16} aria-hidden /></button>
              </div>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
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

function BrowserSetup({ heading }: { heading: React.RefObject<HTMLHeadingElement | null> }) {
  const [dir, setDir] = useState<string | null>(null)
  const [dirFailed, setDirFailed] = useState(false)
  const [opening, setOpening] = useState(false)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<RelayBridgeStatus | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  useEffect(() => {
    let alive = true
    void Promise.resolve(window.ndm?.extensionPath?.()).then(value => {
      if (alive) { setDir(value ?? null); setDirFailed(!value) }
    }).catch(() => { if (alive) setDirFailed(true) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const reply = await window.ndm?.request('getBridgeStatus')
        const parsed = parseRelayBridgeStatus(reply)
        if (alive) {
          setStatus(parsed); setStatusFailed(false)
          if (describeRelayStatus(parsed).verified) { setError(''); setOpened(false) }
        }
      } catch { if (alive) { setStatus(null); setStatusFailed(true) } }
      finally { if (alive) timer = setTimeout(() => { void refresh() }, 1800) }
    }
    void refresh()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])
  const presentation = describeRelayStatus(status, statusFailed)
  const openDirectory = async (): Promise<void> => {
    if (!dir || opening) return
    setOpening(true); setError(''); setOpened(false)
    try {
      const failure = await openPath(dir)
      if (failure) throw new Error(failure)
      setOpened(true)
    } catch { setError(`未能打开扩展目录。请在设置中的“浏览器扩展”重试。`) }
    finally { setOpening(false) }
  }
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
      </div> : <><ol className="onboarding-instructions">
        <li><span>1</span><p>在 Chrome、Arc 或 Edge 中打开扩展页面，开启“开发者模式”。</p></li>
        <li><span>2</span><p>选择“加载已解压的扩展程序”，选取 NDM 的扩展文件夹。</p></li>
      </ol>
      <button type="button" className="onboarding-directory" disabled={!dir || opening} onClick={() => void openDirectory()}><FolderOpen size={17} aria-hidden />{opening ? '正在打开…' : '打开扩展目录'}<ArrowRight size={15} aria-hidden /></button>
      <p className="onboarding-directory-note" role="status">{error || (opened ? `已在${FILE_MANAGER}中打开。加载后会自动检测连接。` : dirFailed ? '扩展目录暂不可用，可稍后在设置中重试。' : presentation.detail || '安装完成后，这里会自动显示连接状态。')}</p></>}
    </div>
  </>
}
