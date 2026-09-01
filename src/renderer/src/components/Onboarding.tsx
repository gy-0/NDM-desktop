import { useEffect, useState } from 'react'
import { ArrowRight, Check, FileDown, Folder, Gauge, Lock, Puzzle, ShieldCheck } from 'lucide-react'
import { openPath } from '../lib/store'
import { cue } from '../lib/sound'
import { FILE_MANAGER, IS_WINDOWS } from '../lib/platform'

const STEP_COUNT = IS_WINDOWS ? 2 : 3

export function Onboarding({ open, onFinish }: { open: boolean; onFinish: () => void }) {
  const [step, setStep] = useState(0)
  const [extensionDir, setExtensionDir] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)
  // t-page-slide: travel direction flips which side each page enters/exits.
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [pageMotionReady, setPageMotionReady] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep(0)
    setDirection('forward')
    setOpened(false)
    void window.ndm?.extensionPath?.().then((dir) => setExtensionDir(dir ?? null))
  }, [open])

  useEffect(() => {
    if (!open) {
      setPageMotionReady(false)
      return
    }
    setPageMotionReady(false)
    const frame = window.requestAnimationFrame(() => setPageMotionReady(true))
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        advance()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `advance`/`finish` are hoisted declarations that read `step` from this render.
  }, [open, step])

  if (!open) return null

  function finish(): void {
    cue('success')
    onFinish()
  }

  function advance(): void {
    if (step >= STEP_COUNT - 1) {
      finish()
      return
    }
    setDirection('forward')
    setStep((current) => current + 1)
    cue('page')
  }

  return (
    <div className="onboarding-scrim absolute inset-0 z-40 grid place-items-center bg-ink/70 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="欢迎使用 NDM"
        className="onboarding-dialog w-[min(520px,100%)] overflow-hidden rounded-xl border border-line-strong bg-raised shadow-[0_16px_36px_-18px_rgb(0_0_0/0.72)]"
      >
        <div className="px-7 pt-7">
          <div className="t-page-slide" data-dir={direction} data-ready={pageMotionReady ? 'true' : 'false'}>
            <div className={`t-page ${step === 0 ? 'is-active' : ''}`}>
              <StepValue />
            </div>
            <div className={`t-page ${!IS_WINDOWS && step === 1 ? 'is-active' : ''}`}>
              <StepRelay dir={extensionDir} opened={opened} onOpen={() => {
                if (extensionDir) {
                  void openPath(extensionDir)
                  setOpened(true)
                  cue('success')
                }
              }} />
            </div>
            <div className={`t-page ${IS_WINDOWS ? (step === 1 ? 'is-active' : '') : step === 2 ? 'is-active' : ''}`}>
              <StepPrivacy />
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-line/60 px-7 py-4">
          <div className="flex items-center gap-2.5 text-[11px] tabular-nums text-mist">
            <span aria-hidden className="flex items-center gap-1">
              {Array.from({ length: STEP_COUNT }, (_, index) => (
                <span key={index} className={`h-1.5 w-1.5 rounded-[2px] ${index === step ? 'bg-accent' : 'bg-line-strong'}`} />
              ))}
            </span>
            <span>第 {step + 1} 步，共 {STEP_COUNT} 步</span>
          </div>
          <div className="flex items-center gap-3">
            {step < STEP_COUNT - 1 ? (
              <button
                type="button"
                onClick={finish}
                className="text-[11.5px] text-mist transition-colors hover:text-paper"
              >
                跳过
              </button>
            ) : null}
            <button
              type="button"
              data-cuelume-press
              data-cuelume-release
              onClick={advance}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-colors duration-100 hover:bg-paper"
            >
              {step === STEP_COUNT - 1 ? '开始使用' : '继续'}
              {step === STEP_COUNT - 1 ? <Check size={13} strokeWidth={2.4} /> : <ArrowRight size={13} strokeWidth={2.2} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Title({ title, lead }: { title: string; lead: string }) {
  return (
    <>
      <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-paper">{title}</h2>
      <p className="mt-2 text-[12.5px] leading-relaxed text-mist">{lead}</p>
    </>
  )
}

function StepValue() {
  return (
    <div>
      <div className="flex items-start gap-3">
        <FileDown size={19} strokeWidth={1.7} className="mt-0.5 shrink-0 text-fog" />
        <div>
          <Title
            title="开始下载"
            lead="粘贴链接，或把文件拖进来。NDM 会在可用时分段并行下载，断线后从已完成的位置继续。"
          />
        </div>
      </div>
      <ul className="mt-5 grid gap-3 border-t border-line pt-4">
        <Bullet icon={Gauge} title="多线程加速" note={`单个任务最多 ${IS_WINDOWS ? 16 : 32} 路并发，大文件也能吃满带宽。`} />
        <Bullet icon={FileDown} title="视频与文件" note={IS_WINDOWS ? '网页视频与普通文件用同一套界面处理。' : '网页视频、合集与普通文件用同一套界面处理。'} />
        {IS_WINDOWS
          ? <Bullet icon={Puzzle} title="BT 与磁力链" note="直接粘贴磁力链或在线 torrent 地址，aria2 会接管下载。" />
          : <Bullet icon={Puzzle} title="浏览器直接接管" note="装上 NDM Relay，浏览器里的下载会直接交给 NDM。" />}
      </ul>
    </div>
  )
}

function StepRelay({ dir, opened, onOpen }: { dir: string | null; opened: boolean; onOpen: () => void }) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <Puzzle size={19} strokeWidth={1.7} className="mt-0.5 shrink-0 text-fog" />
        <div>
          <Title
            title="连接浏览器"
            lead="扩展在本机运行，把浏览器的下载和网页视频转交给 NDM。现在装或以后在设置里装都行。"
          />
        </div>
      </div>
      <ol className="mt-5 space-y-2.5 border-t border-line pt-4 text-[12px]">
        <Instruction index={1} text="打开 Chrome、Arc 或 Edge 的扩展页面，开启右上角的开发者模式。" />
        <Instruction index={2} text="点击“加载已解压的扩展程序”，选中下面这个目录。" />
      </ol>
      {dir ? (
        <div className="mt-4 rounded-lg border border-line-strong bg-panel p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-paper">
            <Folder size={12} strokeWidth={1.7} className="text-fog" />
            本地扩展目录
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fog" title={dir}>
              {dir}
            </span>
            <button
              type="button"
              data-cuelume-press
              data-cuelume-release
              onClick={onOpen}
              className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition-colors hover:bg-paper"
            >
              打开扩展目录
            </button>
          </div>
          {opened ? (
            <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-sage">
              <Check size={11} strokeWidth={2.4} />
              已在{FILE_MANAGER}中打开，把这个文件夹拖进扩展页面即可。
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 border-l-2 border-line-strong px-3 py-1 text-[11.5px] text-mist">
          正在定位扩展目录，稍后可以在「设置 › 浏览器扩展」里再装。
        </p>
      )}
    </div>
  )
}

function StepPrivacy() {
  return (
    <div>
      <div className="flex items-start gap-3">
        <ShieldCheck size={19} strokeWidth={1.7} className="mt-0.5 shrink-0 text-sage" />
        <div>
          <Title
            title="数据保存在本机"
            lead="NDM 不需要账号，也不会把你的链接或文件送去别处。"
          />
        </div>
      </div>
      <ul className="mt-5 grid gap-3 border-t border-line pt-4">
        <Bullet icon={Lock} title="本地优先" note="任务列表、文件与设置都存在本机，不上传。" />
        {IS_WINDOWS
          ? <Bullet icon={Puzzle} title="引擎也在本地" note="aria2 与 yt-dlp 随应用安装，任务与链接不经过 NDM 云端。" />
          : <Bullet icon={Puzzle} title="Relay 也在本地" note="扩展通过 127.0.0.1 的本机桥接与 NDM 通信。" />}
        <Bullet icon={ShieldCheck} title="无广告" note="免费档保持可用，不会反复显示付费提醒。" />
      </ul>
    </div>
  )
}

function Bullet({
  icon: Icon,
  title,
  note
}: {
  icon: typeof Gauge
  title: string
  note: string
}) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon size={14} strokeWidth={1.7} className="mt-[1px] shrink-0 text-fog" />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-paper">{title}</span>
        <span className="block text-[11.5px] leading-relaxed text-mist">{note}</span>
      </span>
    </li>
  )
}

function Instruction({ index, text }: { index: number; text: string }) {
  return (
    <li className="flex items-start gap-2.5 text-mist">
      <span className="mt-[1px] w-[17px] shrink-0 text-right text-[11px] tabular-nums text-fog">{index}.</span>
      <span className="min-w-0 leading-relaxed">{text}</span>
    </li>
  )
}
