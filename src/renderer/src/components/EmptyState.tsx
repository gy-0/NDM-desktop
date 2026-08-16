import { motion, useReducedMotion } from 'motion/react'
import { ArrowDown, Plus, Sparkles } from 'lucide-react'

export function EmptyState({
  filter,
  onNew
}: {
  filter: string
  onNew: () => void
}) {
  const reduced = useReducedMotion()
  const firstRun = filter === 'all'

  return (
    <div className="grid h-full place-items-center px-8 py-16">
      <div className="flex max-w-[380px] flex-col items-center text-center">
        {/* Brand mark: an incoming-download glyph with a living copper ring. */}
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 10, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
          className="relative grid size-[88px] place-items-center"
        >
          <span
            aria-hidden
            className="absolute inset-0 rounded-[26px]"
            style={{
              background:
                'conic-gradient(from 200deg, color-mix(in srgb, var(--accent) 0%, transparent 35%), color-mix(in srgb, var(--accent) 70%, transparent) 70%, transparent 100%)',
              maskImage: 'radial-gradient(circle, transparent 58%, black 60%, black 72%, transparent 74%)',
              WebkitMaskImage: 'radial-gradient(circle, transparent 58%, black 60%, black 72%, transparent 74%)',
              opacity: 0.55
            }}
          />
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-[26px]"
            style={{
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--line-strong) 80%, transparent), 0 10px 30px rgba(0,0,0,0.18)',
              background: 'linear-gradient(160deg, var(--raised), color-mix(in srgb, var(--raised) 70%, var(--panel)))'
            }}
            animate={reduced ? undefined : { boxShadow: [
              'inset 0 0 0 1px color-mix(in srgb, var(--line-strong) 80%, transparent), 0 10px 30px rgba(0,0,0,0.18)',
              'inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), 0 14px 38px rgba(0,0,0,0.22)',
              'inset 0 0 0 1px color-mix(in srgb, var(--line-strong) 80%, transparent), 0 10px 30px rgba(0,0,0,0.18)'
            ] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.span
            className="relative text-copper"
            animate={reduced ? undefined : { y: [0, 4, 0] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
          >
            <ArrowDown size={30} strokeWidth={1.6} />
          </motion.span>
        </motion.div>

        <motion.h2
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.06, ease: [0.23, 1, 0.32, 1] }}
          className="mt-6 font-serif text-[27px] leading-tight tracking-[-0.02em] text-fog"
        >
          {firstRun ? '你的下载，从这里开始' : '这里还空着'}
        </motion.h2>

        <motion.p
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.12, ease: [0.23, 1, 0.32, 1] }}
          className="mt-2 text-[13px] leading-relaxed text-mist"
        >
          {firstRun
            ? '粘贴一个链接，或把文件拖进来。视频、合集、大文件——NDM 会用多线程帮你稳稳接住。'
            : '当前分类下还没有项目。换个筛选，或添加一个新的下载。'}
        </motion.p>

        <motion.div
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.18, ease: [0.23, 1, 0.32, 1] }}
          className="mt-6 flex flex-col items-center gap-3"
        >
          <button
            type="button"
            data-cuelume-press
            data-cuelume-release
            onClick={onNew}
            className="inline-flex items-center gap-2 rounded-full bg-copper px-5 py-2 text-[13.5px] font-medium text-on-accent shadow-[0_6px_20px_color-mix(in_srgb,var(--accent)_40%,transparent)] transition-[filter,transform] duration-100 hover:brightness-105 active:scale-[0.97]"
          >
            <Plus size={15} strokeWidth={2.2} />
            添加下载
          </button>

          <div className="flex items-center gap-2 text-[11px] text-mist">
            <kbd className="rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-fog">⌘N</kbd>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Sparkles size={11} className="text-copper/80" />
              或把链接 / 文件拖到这里
            </span>
          </div>
        </motion.div>

        {firstRun ? (
          <motion.p
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="mt-7 text-[11px] text-mist/80"
          >
            装好 NDM Relay 扩展后，浏览器里的视频和下载会直接交到这里。
          </motion.p>
        ) : null}
      </div>
    </div>
  )
}
