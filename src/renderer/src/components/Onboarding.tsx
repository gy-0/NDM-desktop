import { useEffect, useState } from 'react'
import { ArrowDown, ArrowRight, Check, Folder, Gauge, Lock, Puzzle, ShieldCheck, Sparkles } from 'lucide-react'
import { openPath } from '../lib/store'
import { cue } from '../lib/sound'
import { FILE_MANAGER, IS_WINDOWS } from '../lib/platform'
import { BorderBeam } from './ui/border-beam'

const STEP_COUNT = IS_WINDOWS ? 2 : 3

export function Onboarding({ open, onFinish }: { open: boolean; onFinish: () => void }) {
  const [step, setStep] = useState(0)
  const [extensionDir, setExtensionDir] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep(0)
    setOpened(false)
    void window.ndm?.extensionPath?.().then((dir) => setExtensionDir(dir ?? null))
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
    setStep((current) => current + 1)
    cue('page')
  }

  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center bg-ink/65 p-6 backdrop-blur-[3px]"
      style={{ animation: 'fade-in 200ms ease both' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="欢迎使用 NDM"
        className="relative w-[min(520px,100%)] overflow-hidden rounded-[20px] border border-line-strong bg-raised/98 shadow-[0_28px_80px_rgb(0_0_0/0.45)]"
        style={{ animation: 'fade-up 320ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <BorderBeam size={60} duration={8} borderWidth={1} colorFrom="#d79343" colorTo="#f7efe2" initialOffset={20} />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[200px]"
          style={{
            background:
              'radial-gradient(85% 120% at 20% -20%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 60%)'
          }}
        />

        <div className="relative px-7 pt-7">
          {step === 0 ? <StepValue /> : !IS_WINDOWS && step === 1 ? <StepRelay dir={extensionDir} opened={opened} onOpen={() => {
            if (extensionDir) {
              void openPath(extensionDir)
              setOpened(true)
              cue('success')
            }
          }} /> : <StepPrivacy />}
        </div>

        <div className="relative mt-6 flex items-center justify-between border-t border-line/60 px-7 py-4">
          <div className="flex items-center gap-1.5" aria-hidden>
            {Array.from({ length: STEP_COUNT }, (_, index) => (
              <span
                key={index}
                className="h-[3px] rounded-full transition-[width,background-color] duration-300"
                style={{
                  width: index === step ? 18 : 6,
                  background: index === step ? 'var(--accent)' : 'var(--line-strong)',
                  transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)'
                }}
              />
            ))}
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
              className="inline-flex items-center gap-1.5 rounded-full bg-copper px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-[filter,transform] duration-100 hover:brightness-105 active:scale-[0.96]"
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

function Title({ eyebrow, title, lead }: { eyebrow: string; title: string; lead: string }) {
  return (
    <>
      <div className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-copper">{eyebrow}</div>
      <h2 className="mt-2 font-serif text-[28px] leading-tight tracking-[-0.02em] text-paper">{title}</h2>
      <p className="mt-2 text-[12.5px] leading-relaxed text-mist">{lead}</p>
    </>
  )
}

function StepValue() {
  return (
    <div style={{ animation: 'fade-up 240ms cubic-bezier(0.23,1,0.32,1) both' }}>
      <span className="grid size-11 place-items-center rounded-[14px] bg-copper/14 text-copper shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_26%,transparent)]">
        <ArrowDown size={22} strokeWidth={1.7} />
      </span>
      <div className="mt-4">
        <Title
          eyebrow="欢迎使用 NDM"
          title="把下载这件事做稳"
          lead="粘贴链接，或把文件拖进来。NDM 会分段并行抓取，断线自动续传。"
        />
      </div>
      <ul className="mt-4 grid gap-2.5">
        <Bullet icon={Gauge} title="多线程加速" note={`单个任务最多 ${IS_WINDOWS ? 16 : 32} 路并发，大文件也能吃满带宽。`} />
        <Bullet icon={Sparkles} title="视频与文件一体" note={IS_WINDOWS ? '网页视频与普通文件用同一套界面处理。' : '网页视频、合集与普通文件用同一套界面处理。'} />
        {IS_WINDOWS
          ? <Bullet icon={Puzzle} title="BT 与磁力链" note="直接粘贴磁力链或在线 torrent 地址，aria2 会接管下载。" />
          : <Bullet icon={Puzzle} title="浏览器直接接管" note="装上 NDM Relay，浏览器里的下载会直接交给 NDM。" />}
      </ul>
    </div>
  )
}

function StepRelay({ dir, opened, onOpen }: { dir: string | null; opened: boolean; onOpen: () => void }) {
  return (
    <div style={{ animation: 'fade-up 240ms cubic-bezier(0.23,1,0.32,1) both' }}>
      <span className="grid size-11 place-items-center rounded-[14px] bg-copper/14 text-copper shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_26%,transparent)]">
        <Puzzle size={20} strokeWidth={1.7} />
      </span>
      <div className="mt-4">
        <Title
          eyebrow="第二步"
          title="装上 NDM Relay"
          lead="扩展在本机运行，把浏览器的下载和网页视频转交给 NDM。现在装或以后在设置里装都行。"
        />
      </div>
      <ol className="mt-4 space-y-2 text-[12px]">
        <Instruction index={1} text="打开 Chrome、Arc 或 Edge 的扩展页面，开启右上角的开发者模式。" />
        <Instruction index={2} text="点击“加载已解压的扩展程序”，选中下面这个目录。" />
      </ol>
      {dir ? (
        <div className="mt-3 rounded-[12px] border border-line-strong bg-panel/70 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-paper">
            <Folder size={12} strokeWidth={1.7} className="text-copper" />
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
              className="shrink-0 rounded-md border border-line-strong bg-raised px-2.5 py-1 text-[11px] font-medium text-copper transition-colors hover:bg-copper hover:text-on-accent"
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
        <p className="mt-3 rounded-[12px] border border-line bg-ink/20 px-3 py-2.5 text-[11.5px] text-mist">
          正在定位扩展目录，稍后可以在「设置 › 浏览器扩展」里再装。
        </p>
      )}
    </div>
  )
}

function StepPrivacy() {
  return (
    <div style={{ animation: 'fade-up 240ms cubic-bezier(0.23,1,0.32,1) both' }}>
      <span className="grid size-11 place-items-center rounded-[14px] bg-sage/14 text-sage shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ok)_26%,transparent)]">
        <ShieldCheck size={20} strokeWidth={1.7} />
      </span>
      <div className="mt-4">
        <Title
          eyebrow={IS_WINDOWS ? '第二步' : '第三步'}
          title={`下载只留在你这台${IS_WINDOWS ? '电脑' : ' Mac'}上`}
          lead="NDM 不需要账号，也不会把你的链接或文件送去别处。"
        />
      </div>
      <ul className="mt-4 grid gap-2.5">
        <Bullet icon={Lock} title="本地优先" note="任务列表、文件与设置都存在本机，不上传。" />
        {IS_WINDOWS
          ? <Bullet icon={Puzzle} title="引擎也在本地" note="aria2 与 yt-dlp 随应用安装，任务与链接不经过 NDM 云端。" />
          : <Bullet icon={Puzzle} title="Relay 也在本地" note="扩展通过 127.0.0.1 的本机桥接与 NDM 通信。" />}
        <Bullet icon={ShieldCheck} title="没有广告与弹窗" note="免费档就是完整可用的，不会反复催你付费。" />
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
    <li className="flex items-start gap-2.5 rounded-[12px] border border-line bg-ink/20 px-3 py-2.5">
      <Icon size={14} strokeWidth={1.7} className="mt-[1px] shrink-0 text-copper" />
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
      <span className="mt-[1px] grid size-[17px] shrink-0 place-items-center rounded-full bg-copper/14 font-mono text-[10px] text-copper">
        {index}
      </span>
      <span className="min-w-0 leading-relaxed">{text}</span>
    </li>
  )
}
