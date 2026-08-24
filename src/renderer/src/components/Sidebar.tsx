import type { ReactNode } from 'react'
import {
  Archive,
  CheckCircle2,
  CirclePause,
  CircleX,
  Clock3,
  Download,
  Eraser,
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
  onSettings,
  onCleanup
}: {
  filter: FilterId
  engineStatus: EngineStatus
  onFilter: (id: FilterId) => void
  onNew: () => void
  onSettings: () => void
  onCleanup: () => void
}) {
  const tally = counts()
  return (
    <aside className="relative flex min-h-0 w-[clamp(196px,17vw,216px)] shrink-0 flex-col border-r border-line bg-panel pt-[52px]">
      <span aria-hidden className="app-drag absolute inset-x-0 top-0 h-[52px]" />
      <div className="px-2.5 pb-3">
        <div className="px-2 font-serif text-[24px] leading-none tracking-[-0.03em]">NDM</div>
        <button
          type="button"
          data-cuelume-press
          data-cuelume-release
          onClick={onNew}
          className="mt-4 flex h-8 w-full items-center gap-2 rounded-[7px] px-2 text-[12.5px] font-medium text-fog transition-colors duration-100 hover:bg-raised/60 hover:text-paper active:bg-raised"
        >
          <Plus size={16} strokeWidth={1.8} />
          添加下载
        </button>
      </div>
      <nav className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto px-2">
        <>
          <Group title="状态">
            {STATUS_FILTERS.map((item) => (
              <Row
                key={item.id}
                id={item.id}
                label={item.label}
                count={tally[item.id]}
                active={filter === item.id}
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
                onClick={() => onFilter(item.id)}
              />
            ))}
          </Group>
        </>
      </nav>
      <div className="shrink-0 border-t border-line/50 px-2 py-3 space-y-1">
        {engineStatus !== 'live' ? (
          <div className="flex items-center gap-2 px-2 py-1 text-[11.5px] text-mist">
            <span className={`size-1.5 rounded-full ${engineStatus === 'connecting' ? 'bg-mist' : 'bg-clay'}`} />
            <span>{engineStatus === 'connecting' ? '正在连接…' : '连接中断'}</span>
          </div>
        ) : null}
        <button
          type="button"
          data-cuelume-press="page"
          onClick={onCleanup}
          className="flex w-full items-center gap-2 rounded-[7px] px-2 py-2 text-left text-[13px] text-fog transition-[background-color,color,scale] duration-100 hover:bg-raised/60 hover:text-paper active:scale-[0.96]"
        >
          <Eraser size={14} strokeWidth={1.7} />
          整理任务库
          {tally.failed > 0 ? (
            <span className="ml-auto flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-clay/15 px-1 font-mono text-[10px] tabular-nums text-clay">
              {tally.failed > 99 ? '99+' : tally.failed}
            </span>
          ) : null}
        </button>
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
  onClick,
}: {
  id: FilterId
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  const Icon = FILTER_ICONS[id] ?? Archive
  return (
    <button
      type="button"
      data-cuelume-press
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] transition-colors duration-100 active:bg-raised ${
        active ? 'bg-raised font-medium text-paper' : 'text-fog hover:bg-raised/45 hover:text-paper'
      }`}
    >
      <Icon size={14} strokeWidth={1.65} className="shrink-0" />
      <span className="min-w-0 flex-1">{label}</span>
      <span
        className="min-w-[18px] text-right font-mono text-[10.5px] tabular-nums text-mist"
      >
        {count}
      </span>
    </button>
  )
}
