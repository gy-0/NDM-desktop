import type { ReactNode } from 'react'
import {
  Archive,
  CheckCircle2,
  CirclePause,
  CircleX,
  Clock3,
  Download,
  FileArchive,
  FileImage,
  FileText,
  Film,
  Grid2X2,
  Headphones,
  Package,
  Plus,
  Settings2,
  type LucideIcon
} from 'lucide-react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { STATUS_FILTERS, TYPE_FILTERS } from '../lib/filters'
import { counts } from '../lib/store'
import type { FilterId } from '../lib/types'

const FILTER_ICONS: Partial<Record<FilterId, LucideIcon>> = {
  all: Grid2X2,
  active: Download,
  queued: Clock3,
  paused: CirclePause,
  completed: CheckCircle2,
  failed: CircleX,
  video: Film,
  audio: Headphones,
  document: FileText,
  compressed: FileArchive,
  application: Package,
  image: FileImage,
  misc: Archive
}

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
  const reducedMotion = useReducedMotion()
  return (
    <aside className="relative flex min-h-0 w-[clamp(188px,18vw,220px)] shrink-0 flex-col border-r border-line bg-panel pt-[52px]">
      <span aria-hidden className="app-drag absolute inset-x-0 top-0 h-[52px]" />
      <div className="px-2 pb-4">
        <div className="px-2 font-serif text-[28px] leading-none tracking-tight">NDM</div>
        <div className="mt-2 px-2 text-[11px] uppercase tracking-[0.16em] text-mist">下载</div>
        <button
          type="button"
          data-cuelume-press
          data-cuelume-release
          onClick={onNew}
          className="mt-4 flex w-full items-center gap-2 rounded-[9px] px-2 py-2 text-[13.5px] font-medium text-copper transition-[background-color,color,scale] duration-100 hover:bg-copper/10 hover:text-paper active:scale-[0.96]"
        >
          <Plus size={16} strokeWidth={1.8} />
          添加下载
        </button>
      </div>
      <nav className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto px-2">
        <LayoutGroup id="sidebar-selection">
          <Group title="状态">
            {STATUS_FILTERS.map((item) => (
              <Row
                key={item.id}
                id={item.id}
                label={item.label}
                count={tally[item.id]}
                active={filter === item.id}
                reducedMotion={Boolean(reducedMotion)}
                onClick={() => onFilter(item.id)}
              />
            ))}
          </Group>
          <Group title="类型">
            {TYPE_FILTERS.map((item) => (
              <Row
                key={item.id}
                id={item.id}
                label={item.label}
                count={tally[item.id]}
                active={filter === item.id}
                reducedMotion={Boolean(reducedMotion)}
                onClick={() => onFilter(item.id)}
              />
            ))}
          </Group>
        </LayoutGroup>
      </nav>
      <div className="shrink-0 border-t border-line/50 px-2 py-3 space-y-1">
        {engineStatus !== 'live' ? (
          <div className="flex items-center gap-2 px-2 py-1 text-[11.5px] text-mist">
            <span className={`size-1.5 rounded-full ${engineStatus === 'connecting' ? 'bg-copper animate-pulse' : 'bg-clay'}`} />
            <span>{engineStatus === 'connecting' ? '正在连接…' : '连接中断'}</span>
          </div>
        ) : null}
        <button
          type="button"
          data-cuelume-press="page"
          onClick={onSettings}
          className="flex w-full items-center gap-2 rounded-[7px] px-2 py-2 text-left text-[13px] text-fog transition-[background-color,color,scale] duration-100 hover:bg-raised/60 hover:text-paper active:scale-[0.96]"
        >
          <Settings2 size={14} strokeWidth={1.7} />
          设置
        </button>
      </div>
    </aside>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="pb-1 pl-8 text-[10.5px] font-medium uppercase tracking-[0.08em] text-mist">{title}</div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

function Row({
  id,
  label,
  count,
  active,
  reducedMotion,
  onClick,
}: {
  id: FilterId
  label: string
  count: number
  active: boolean
  reducedMotion: boolean
  onClick: () => void
}) {
  const Icon = FILTER_ICONS[id] ?? Archive
  return (
    <button
      type="button"
      data-cuelume-press
      onClick={onClick}
      className={`relative isolate flex w-full items-center gap-2 overflow-hidden rounded-[8px] px-2 py-1.5 text-left text-[13px] transition-[color,background-color,scale] duration-100 active:scale-[0.96] ${
        active ? 'font-medium text-paper' : 'text-fog hover:bg-raised/40 hover:text-paper'
      }`}
    >
      {active ? (
        <motion.span
          aria-hidden
          layoutId="sidebar-active-indicator"
          className="absolute inset-0 -z-10 rounded-[8px] bg-raised shadow-[inset_2px_0_0_color-mix(in_srgb,var(--accent)_68%,transparent),0_4px_14px_rgb(0_0_0/0.08)]"
          transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 470, damping: 38, mass: 0.72 }}
        />
      ) : null}
      <Icon size={14} strokeWidth={1.7} className="relative z-10 shrink-0" />
      <span className="relative z-10 min-w-0 flex-1">{label}</span>
      <span
        className={`relative z-10 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[10.5px] tabular-nums ${
          active ? 'bg-ink text-mist' : 'text-mist'
        }`}
      >
        {count}
      </span>
    </button>
  )
}
