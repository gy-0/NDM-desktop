import { useEffect, useState } from 'react'
import { ArrowRight, Check, Crown, Gift, KeyRound, Mail, Sparkles, X } from 'lucide-react'
import { cue } from '../lib/sound'
import { BorderBeam } from './ui/border-beam'
import { AnimatedShinyText } from './ui/animated-shiny-text'
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

  useEffect(() => {
    if (open) {
      setRedeeming(startInRedeem ?? false)
      return
    }
    setRedeeming(false)
    setEmail('')
    setKey('')
    setError(null)
  }, [open, startInRedeem])

  if (!open) return null

  const handleClose = (): void => {
    cue('release')
    onClose()
  }

  const handleRedeem = (): void => {
    const result = redeem(key, email)
    if (!result.ok) {
      setError(result.error)
      cue('error')
      return
    }
    setError(null)
    setRedeeming(false)
    cue('success')
  }

  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center bg-ink/55 p-6 backdrop-blur-[2px]"
      style={{ animation: 'fade-in 160ms ease both' }}
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="NDM Pro"
        className="relative max-h-full w-[min(560px,100%)] overflow-y-auto rounded-[20px] border border-line-strong bg-raised/98 shadow-[0_28px_80px_rgb(0_0_0/0.45)] backdrop-blur-md scroll-quiet"
        style={{ animation: 'fade-up 260ms cubic-bezier(0.23,1,0.32,1) both' }}
        onClick={(event) => event.stopPropagation()}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[180px] rounded-t-[20px]"
          style={{
            background:
              'radial-gradient(90% 120% at 82% -20%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 62%)'
          }}
        />

        <div className="relative flex items-start justify-between px-6 pt-6">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.16em] text-copper">
              <Crown size={12} strokeWidth={2} />
              <AnimatedShinyText className="text-copper">{license ? 'NDM Pro · 已激活' : 'NDM Pro'}</AnimatedShinyText>
            </div>
            <h2 className="mt-2 font-serif text-[27px] leading-tight tracking-[-0.02em] text-paper">
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
          <div className="relative px-6 pb-6 pt-5">
            <div className="rounded-[14px] border border-line-strong bg-panel/70 p-4">
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-paper">
                <Sparkles size={13} className="text-copper" />
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
                className="rounded-full bg-copper px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-transform duration-150 active:scale-[0.96]"
              >
                好了
              </button>
            </div>
          </div>
        ) : redeeming ? (
          <div className="relative px-6 pb-6 pt-5">
            <div className="rounded-[14px] border border-line-strong bg-panel/70 p-4">
              <div className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-mist">输入激活码</div>
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
              {error ? <p className="mt-2 text-[11.5px] text-clay">{error}</p> : null}
              <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-ink/25 px-2.5 py-2 text-[10.5px] leading-relaxed text-mist">
                <Gift size={12} strokeWidth={1.7} className="mt-[1px] shrink-0 text-copper" />
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
                className="rounded-full bg-copper px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-transform duration-150 active:scale-[0.96] disabled:opacity-50"
              >
                激活
              </button>
            </div>
          </div>
        ) : (
          <div className="relative px-6 pb-6 pt-5">
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-[14px] border border-line bg-ink/20 p-3.5">
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

              <div
                className="relative overflow-hidden rounded-[14px] border border-copper/45 bg-copper/[0.07] p-3.5"
                style={{ boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent) 16%, transparent)' }}
              >
                <BorderBeam size={42} duration={7} borderWidth={1.5} colorFrom="#d79343" colorTo="#f7efe2" />
                <div className="flex items-baseline justify-between">
                  <span className="flex items-center gap-1 text-[12.5px] font-medium text-paper">
                    <Crown size={12} strokeWidth={2} className="text-copper" />
                    Pro
                  </span>
                  <span className="font-mono text-[11px] text-mist line-through">${PRO_PRICING.regular}</span>
                </div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="font-serif text-[28px] leading-none text-paper">${PRO_PRICING.earlyBird}</span>
                  <span className="text-[10.5px] text-copper">早鸟 · 一次性</span>
                </div>
                <ul className="mt-3 space-y-1.5">
                  {PRO_FEATURES.map((feature) => (
                    <li key={feature.id} className="flex items-start gap-1.5 text-[11.5px]">
                      <Check size={11} strokeWidth={2.4} className="mt-[3.5px] shrink-0 text-copper" />
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
              个人授权含 {PRO_PRICING.seats} 台 Mac，之后的所有更新都包含在内。没有订阅，没有“终身”文字游戏。
            </p>

            <div className="mt-4 flex items-center justify-between gap-3 border-t border-line/60 pt-3.5">
              <button
                type="button"
                onClick={() => {
                  setRedeeming(true)
                  cue('page')
                }}
                className="text-[11.5px] text-copper transition-colors hover:underline"
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
                className="inline-flex items-center gap-1.5 rounded-full bg-copper px-4 py-2 text-[13px] font-medium text-on-accent shadow-[0_6px_20px_color-mix(in_srgb,var(--accent)_34%,transparent)] transition-[filter,transform] duration-100 hover:brightness-105 active:scale-[0.97]"
              >
                升级到 NDM Pro
                <ArrowRight size={14} strokeWidth={2.2} />
              </button>
            </div>
            <p className="mt-2.5 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-mist/85">
              <Gift size={11} strokeWidth={1.7} className="mt-[1.5px] shrink-0 text-copper/80" />
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
