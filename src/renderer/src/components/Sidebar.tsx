import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { STATUS_FILTERS, TYPE_FILTERS } from '../lib/filters'
import { counts } from '../lib/store'
import type { FilterId } from '../lib/types'

export function Sidebar({
  filter,
  engineStatus,
  onFilter,
  onNew,
  onSettings
}: {
  filter: FilterId
  engineStatus: EngineStatus
  onFilter: (id: FilterId) => void
  onNew: () => void
  onSettings: () => void
}) {
  const tally = counts()
  const navRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [hovered, setHovered] = useState<string | null>(null)
  const [box, setBox] = useState<{ top: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const container = navRef.current
    const target = itemRefs.current[hovered ?? filter]
    if (!container || !target) return
    const parent = container.getBoundingClientRect()
    const next = target.getBoundingClientRect()
    setBox({ top: next.top - parent.top, height: next.height })
  }, [hovered, filter])

  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-panel pt-[52px]">
      <div className="px-4 pb-4">
        <div className="font-serif text-[28px] leading-none tracking-tight">NDM</div>
        <div className="mt-2 text-[11px] uppercase tracking-[0.16em] text-mist">下载</div>
        <button
          type="button"
          data-cuelume-press
          data-cuelume-release
          onClick={onNew}
          className="mt-4 flex w-full items-center justify-between rounded-[9px] px-2 py-1.5 text-[13px] font-medium text-copper transition-[background-color,transform] duration-100 hover:bg-white/4 active:scale-[0.96]"
        >
          添加下载
          <span className="grid size-4 place-items-center rounded-full bg-copper text-[11px] text-on-accent">+</span>
        </button>
      </div>
      <nav
        ref={navRef}
        className="relative flex-1 px-2"
        onMouseLeave={() => setHovered(null)}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-2 rounded-[7px] bg-raised"
          style={{
            top: box?.top ?? 0,
            height: box?.height ?? 0,
            opacity: box ? 1 : 0,
            transition:
              'top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease'
          }}
        />
        <Group title="状态">
          {STATUS_FILTERS.map((item) => (
            <Row
              key={item.id}
              label={item.label}
              count={tally[item.id]}
              active={filter === item.id}
              onHover={() => setHovered(item.id)}
              bindRef={(el) => {
                itemRefs.current[item.id] = el
              }}
              onClick={() => onFilter(item.id)}
            />
          ))}
        </Group>
        <Group title="类型">
          {TYPE_FILTERS.map((item) => (
            <Row
              key={item.id}
              label={item.label}
              count={tally[item.id]}
              active={filter === item.id}
              onHover={() => setHovered(item.id)}
              bindRef={(el) => {
                itemRefs.current[item.id] = el
              }}
              onClick={() => onFilter(item.id)}
            />
          ))}
        </Group>
      </nav>
      <div className="px-3 pb-4">
        <div className="px-2 pb-2 text-[11px] text-mist">
          {engineStatus === 'live' ? '引擎已连接' : engineStatus === 'connecting' ? '正在连接引擎…' : '引擎未连接'}
        </div>
        <button
          type="button"
          data-cuelume-press="page"
          onClick={onSettings}
          className="w-full rounded-[7px] px-2 py-1.5 text-left text-[12.5px] text-mist transition-colors duration-100 hover:text-paper"
        >
          设置
        </button>
      </div>
    </aside>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-mist">{title}</div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

function Row({
  label,
  count,
  active,
  onClick,
  onHover,
  bindRef
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  onHover: () => void
  bindRef: (el: HTMLButtonElement | null) => void
}) {
  return (
    <button
      ref={bindRef}
      type="button"
      data-cuelume-hover="tick"
      data-cuelume-press
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onClick}
      className={`relative z-10 flex w-full items-center justify-between rounded-[7px] px-2 py-1.5 text-left text-[13px] transition-[color,transform] duration-150 active:scale-[0.96] ${
        active ? 'font-medium text-paper' : 'text-fog'
      }`}
    >
      <span>{label}</span>
      <span
        className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[10.5px] tabular-nums ${
          active ? 'bg-ink text-mist' : 'text-mist'
        }`}
      >
        {count}
      </span>
    </button>
  )
}
