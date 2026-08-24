import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Crown, Gift, KeyRound, Mail, X } from 'lucide-react'
import { cue } from '../lib/sound'

/** lucide Check path (24×24 viewBox), drawn by t-success-check on activation. */
const CHECK_PATH_D = 'M5 13l4.5 4.5L19 8'

import {
  FREE_FEATURES,
  LICENSE_KEY_PLACEHOLDER,
  PRO_FEATURES,
  PRO_PRICING,
  clearLicense,
  formatActivatedAt,
  normalizeLicenseKey,
  redeem,
  useLicense
} from '../lib/license'

// Keep the close timer in sync with the --modal-close-dur token in index.css.
function modalCloseMs(): number {
  const value = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur')
  )
  return Number.isFinite(value) ? value : 150
}

export function ProModal({
  open,
  reason,
  startInRedeem,
  onClose
}: {
  open: boolean
  /** The capability the user just reached for, so the paywall answers a question. */
  reason?: string | null
  /** Skip the ladder and land straight on the redeem sheet. */
  startInRedeem?: boolean
  onClose: () => void
}) {
  const license = useLicense()
  const [redeeming, setRedeeming] = useState(false)
  const [email, setEmail] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  // t-modal close choreography: keep the dialog mounted while `.is-closing`
  // plays, then unmount. The timer always tracks the latest close request.
  const [closing, setClosing] = useState(false)
  const closingTimer = useRef<number | null>(null)
  // t-input error shake state (transitions.dev 12): `.is-error` holds the
  // treatment, a separate shake timer replays the percussive animation.
  const [errorShown, setErrorShown] = useState(false)
  const errorShakeRef = useRef<HTMLDivElement | null>(null)
  const revertTimer = useRef<number | null>(null)
  const shakeTimer = useRef<number | null>(null)
  // t-success-check: play the stroke-draw celebration right after activation.
  const [justActivated, setJustActivated] = useState(false)

  useEffect(() => {
    if (open) {
      setClosing(false)
      setRedeeming(startInRedeem ?? false)
      return
    }
    setRedeeming(false)
    setEmail('')
    setKey('')
    setError(null)
  }, [open, startInRedeem])

  useEffect(() => {
    return () => {
      if (closingTimer.current !== null) window.clearTimeout(closingTimer.current)
      if (revertTimer.current !== null) window.clearTimeout(revertTimer.current)
      if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current)
    }
  }, [])

  // Read the shake clock from the tokens so JS stays in sync with CSS.
  const shakeMs = (): { total: number; hold: number } => {
    const cs = window.getComputedStyle(document.documentElement)
    const a = Number.parseFloat(cs.getPropertyValue('--shake-dur-a')) || 80
    const b = Number.parseFloat(cs.getPropertyValue('--shake-dur-b')) || 60
    const hold = Number.parseFloat(cs.getPropertyValue('--revert-hold')) || 3000
    return { total: a * 2 + b * 2, hold }
  }

  const showError = (): void => {
    setErrorShown(true)
    // Replay the shake from a clean baseline: remove → reflow → re-add.
    const host = errorShakeRef.current
    if (host) {
      host.classList.remove('is-error')
      void host.offsetWidth
      host.classList.add('is-error')
    }
    if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current)
    if (revertTimer.current !== null) window.clearTimeout(revertTimer.current)
    const { total, hold } = shakeMs()
    shakeTimer.current = window.setTimeout(() => {
      shakeTimer.current = null
      host?.classList.remove('is-error')
    }, total + 20)
    revertTimer.current = window.setTimeout(() => setErrorShown(false), total + hold)
  }

  const clearError = (): void => {
    setErrorShown(false)
    errorShakeRef.current?.classList.remove('is-error')
    if (revertTimer.current !== null) {
      window.clearTimeout(revertTimer.current)
      revertTimer.current = null
    }
    if (shakeTimer.current !== null) {
      window.clearTimeout(shakeTimer.current)
      shakeTimer.current = null
    }
  }

  const beginClose = (): void => {
    if (closing) return
    setClosing(true)
    closingTimer.current = window.setTimeout(() => {
      closingTimer.current = null
      onClose()
    }, modalCloseMs())
  }

  if (!open) return null

  const handleClose = (): void => {
    cue('release')
    beginClose()
  }

  const handleRedeem = (): void => {
    const result = redeem(key, email)
    if (!result.ok) {
      setError(result.error)
      cue('error')
      showError()
      return
    }
    setError(null)
    clearError()
    setRedeeming(false)
    setJustActivated(true)
    cue('success')
  }

  return (
    <div
      className={`t-modal-scrim absolute inset-0 z-40 grid place-items-center bg-ink/70 p-6 ${closing ? 'is-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="NDM Pro"
        className={`t-modal max-h-full w-[min(560px,100%)] overflow-y-auto rounded-xl border border-line-strong bg-raised shadow-[0_16px_36px_-18px_rgb(0_0_0/0.72)] scroll-quiet ${closing ? 'is-closing' : 'is-open'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 pt-6">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-fog">
              <Crown size={13} strokeWidth={1.8} />
              {license ? 'NDM Pro · 已激活' : 'NDM Pro'}
            </div>
            <h2 className="mt-2 text-[21px] font-semibold leading-tight tracking-[-0.015em] text-paper">
              {license ? '已激活 NDM Pro' : '一次买断，永久可用'}
            </h2>
            <p className="mt-1.5 max-w-[380px] text-[12.5px] leading-relaxed text-mist">
              {license
                ? '感谢支持。所有高级能力已在这台 Mac 上解锁，后续更新一并包含。'
                : reason
                  ? `${reason}属于 Pro 能力。没有订阅，没有广告，也不会有弹窗催促。`
                  : '没有订阅，没有广告，也不会有弹窗催促。付一次，往后的更新都包含在内。'}
            </p>
          </div>
          <button
            type="button"
            data-cuelume-press="tick"
            onClick={handleClose}
            className="shrink-0 rounded p-1 text-mist transition-colors hover:bg-line hover:text-paper"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {license ? (
          <div className="px-6 pb-6 pt-5">
            <div className="rounded-lg border border-line-strong bg-panel p-4">
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-paper">
                <span className="t-success-check text-copper" data-state={justActivated ? 'in' : 'out'}>
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d={CHECK_PATH_D} />
                  </svg>
                </span>
                个人授权 · 最多 {PRO_PRICING.seats} 台 Mac
              </div>
              <dl className="mt-3 space-y-2 text-[12px]">
                <Row label="邮箱" value={license.email || '未记录'} />
                <Row label="激活码" value={license.key} />
                <Row label="激活时间" value={formatActivatedAt(license.activatedAt)} />
              </dl>
            </div>
            <ul className="mt-4 grid gap-2">
              {PRO_FEATURES.map((feature) => (
                <li key={feature.id} className="flex items-start gap-2 text-[12.5px]">
                  <Check size={13} strokeWidth={2.4} className="mt-[3px] shrink-0 text-sage" />
                  <span className="min-w-0">
                    <span className="block text-paper">{feature.name}</span>
                    <span className="block text-[11px] text-mist">{feature.note}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex items-center justify-between border-t border-line/60 pt-3">
              <button
                type="button"
                onClick={() => {
                  clearLicense()
                  cue('droplet')
                }}
                className="text-[11.5px] text-mist transition-colors hover:text-clay"
              >
                在这台 Mac 上取消激活
              </button>
              <button
                type="button"
                data-cuelume-press
                data-cuelume-release
                onClick={handleClose}
                className="rounded-lg bg-accent px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-paper"
              >
                好了
              </button>
            </div>
          </div>
        ) : redeeming ? (
          <div className="px-6 pb-6 pt-5">
            <div ref={errorShakeRef} className="rounded-lg border border-line-strong bg-panel p-4">
              <div className="text-[11px] font-semibold text-fog">输入激活码</div>
              <label className="mt-3 block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-mist">
                  <Mail size={12} strokeWidth={1.7} />
                  购买邮箱
                </span>
                <input
                  autoFocus
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    setError(null)
                    clearError()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handleRedeem()
                    }
                  }}
                  placeholder="you@example.com"
                  spellCheck={false}
                  className="w-full rounded-lg border border-line bg-ink/25 px-2.5 py-1.5 text-[12.5px] text-paper outline-none transition-colors placeholder:text-mist/55 focus:border-copper/60"
                />
              </label>
              <label className="mt-3 block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-mist">
                  <KeyRound size={12} strokeWidth={1.7} />
                  激活码
                </span>
                <input
                  value={key}
                  onChange={(event) => {
                    setKey(normalizeLicenseKey(event.target.value))
                    setError(null)
                    clearError()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handleRedeem()
                    }
                  }}
                  placeholder={LICENSE_KEY_PLACEHOLDER}
                  spellCheck={false}
                  className="w-full rounded-lg border border-line bg-ink/25 px-2.5 py-1.5 font-mono text-[12.5px] tracking-[0.06em] text-paper outline-none transition-colors placeholder:text-mist/55 focus:border-copper/60"
                />
              </label>
              {error ? (
                <p
                  role="alert"
                  className={`t-shake-host mt-2 text-[11.5px] text-clay ${errorShown ? 'is-error' : ''}`}
                >
                  {error}
                </p>
              ) : null}
              <p className="mt-3 flex items-start gap-1.5 border-l-2 border-line-strong px-2.5 py-1 text-[10.5px] leading-relaxed text-mist">
                <Gift size={12} strokeWidth={1.7} className="mt-[1px] shrink-0 text-fog" />
                演示：本地激活，商店结算稍后接入。任何符合 {LICENSE_KEY_PLACEHOLDER} 格式的激活码都会在这台 Mac 上解锁 Pro。
              </p>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3">
              <button
                type="button"
                onClick={() => {
                  setRedeeming(false)
                  setError(null)
                  cue('release')
                }}
                className="text-[11.5px] text-mist transition-colors hover:text-paper"
              >
                返回
              </button>
              <button
                type="button"
                data-cuelume-press
                data-cuelume-release
                onClick={handleRedeem}
                disabled={!email.trim() || !key.trim()}
                className="rounded-lg bg-accent px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-paper disabled:opacity-50"
              >
                激活
              </button>
            </div>
          </div>
        ) : (
          <div className="px-6 pb-6 pt-5">
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-lg border border-line bg-panel p-3.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-[12.5px] font-medium text-paper">免费</span>
                  <span className="font-mono text-[11px] text-mist">$0</span>
                </div>
                <p className="mt-1 text-[10.5px] text-mist">日常够用，永远不加广告</p>
                <ul className="mt-3 space-y-1.5">
                  {FREE_FEATURES.map((item) => (
                    <li key={item} className="flex items-start gap-1.5 text-[11.5px] text-fog">
                      <Check size={11} strokeWidth={2.4} className="mt-[3.5px] shrink-0 text-mist" />
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-lg border border-line-strong bg-panel p-3.5">
                <div className="flex items-baseline justify-between">
                  <span className="flex items-center gap-1 text-[12.5px] font-medium text-paper">
                    <Crown size={12} strokeWidth={1.8} className="text-fog" />
                    Pro
                  </span>
                  <span className="font-mono text-[11px] text-mist line-through">${PRO_PRICING.regular}</span>
                </div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-[26px] font-semibold leading-none text-paper">${PRO_PRICING.earlyBird}</span>
                  <span className="text-[10.5px] text-fog">早鸟 · 一次性</span>
                </div>
                <ul className="mt-3 space-y-1.5">
                  {PRO_FEATURES.map((feature) => (
                    <li key={feature.id} className="flex items-start gap-1.5 text-[11.5px]">
                      <Check size={11} strokeWidth={2.4} className="mt-[3.5px] shrink-0 text-fog" />
                      <span className="min-w-0">
                        <span className="block text-paper">{feature.name}</span>
                        <span className="block text-[10px] leading-snug text-mist">{feature.note}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-mist">
              个人授权含 {PRO_PRICING.seats} 台 Mac，不采用订阅制，并包含后续更新。
            </p>

            <div className="mt-4 flex items-center justify-between gap-3 border-t border-line/60 pt-3.5">
              <button
                type="button"
                onClick={() => {
                  setRedeeming(true)
                  cue('page')
                }}
                className="text-[11.5px] text-fog transition-colors hover:text-paper"
              >
                已有激活码？
              </button>
              <button
                type="button"
                data-cuelume-press
                data-cuelume-release
                onClick={() => {
                  setRedeeming(true)
                  cue('bloom')
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-on-accent transition-colors duration-100 hover:bg-paper"
              >
                升级到 NDM Pro
                <ArrowRight size={14} strokeWidth={2.2} />
              </button>
            </div>
            <p className="mt-2.5 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-mist/85">
              <Gift size={11} strokeWidth={1.7} className="mt-[1.5px] shrink-0 text-fog" />
              演示：本地激活，商店结算稍后接入。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-mist">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-[11.5px] text-fog" title={value}>
        {value}
      </dd>
    </div>
  )
}
