import { Crown } from 'lucide-react'

/**
 * The Pro marker. Tasteful and small: it labels a capability, it does not shout.
 * Give it `onClick` to make it the affordance that opens the paywall.
 */
export function ProChip({
  label = 'Pro',
  onClick,
  title
}: {
  label?: string
  onClick?: () => void
  title?: string
}) {
  const shell =
    'inline-flex shrink-0 items-center gap-[3px] rounded-full bg-copper/14 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-[0.09em] text-copper shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_30%,transparent)]'
  const mark = <Crown size={9} strokeWidth={2.2} aria-hidden />

  if (!onClick) {
    return (
      <span className={shell} title={title}>
        {mark}
        {label}
      </span>
    )
  }

  return (
    <button
      type="button"
      title={title ?? '了解 NDM Pro'}
      data-cuelume-press
      data-cuelume-release
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      }}
      className={`${shell} transition-[background-color,scale] duration-100 hover:bg-copper/22 active:scale-[0.94]`}
    >
      {mark}
      {label}
    </button>
  )
}
