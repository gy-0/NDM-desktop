import { formatBytes, formatEta, formatSpeed, fractionOf, remainingSeconds } from '../lib/format'
import { STATUS_LABEL, type Task } from '../lib/types'
import { Connections } from './Connections'
import { TypeMark } from './Marks'

export function TaskRow({
  task,
  selected,
  index,
  onSelect
}: {
  task: Task
  selected: boolean
  index: number
  onSelect: () => void
}) {
  const fraction = fractionOf(task)
  const speed = formatSpeed(task.bytesPerSecond)
  const live = task.status === 'downloading'
  const failed = task.status === 'error'

  return (
    <div
      className={`overflow-hidden bg-raised/40 transition-[border-radius] duration-300 ${
        selected ? 'bg-raised' : ''
      }`}
      style={{
        borderRadius: selected ? 14 : 22,
        animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${index * 60}ms both`
      }}
    >
      <button
        type="button"
        data-cuelume-press="whisper"
        onClick={onSelect}
        className="flex h-11 w-full items-center gap-2.5 px-2.5 text-left transition-colors duration-100"
      >
        <TypeMark category={task.category} size="sm" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{task.title}</span>
        <span className="text-[12.5px] tabular-nums text-mist">
          {live ? `${speed.value} ${speed.unit}` : formatBytes(task.fileSize)}
        </span>
        <Pill task={task} />
      </button>
      <div
        className="grid"
        style={{
          gridTemplateRows: selected ? '1fr' : '0fr',
          opacity: selected ? 1 : 0,
          transition: 'grid-template-rows 300ms cubic-bezier(0.23,1,0.32,1), opacity 300ms cubic-bezier(0.23,1,0.32,1)'
        }}
      >
        <div className="overflow-hidden">
          <div className="grid grid-cols-[24px_1fr] gap-2.5 px-2.5 pb-2.5">
            <span aria-hidden className="mx-auto h-full w-px bg-line" />
            <div className="flex flex-col gap-1.5">
              <Detail label="来源" value={task.source ?? '—'} />
              <Detail
                label="进度"
                value={
                  live
                    ? `${Math.round(fraction * 100)}% · 剩余 ${formatEta(remainingSeconds(task))}`
                    : STATUS_LABEL[task.status]
                }
              />
              {failed && task.errorText ? <Detail label="原因" value={task.errorText} /> : null}
              {live || selected ? <Connections segments={task.segments} /> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Pill({ task }: { task: Task }) {
  if (task.status === 'complete') {
    return <span className="inline-flex h-[22px] items-center rounded-full bg-sage/15 px-2 text-[11.5px] font-medium text-sage">完成</span>
  }
  if (task.status === 'error') {
    return <span className="inline-flex h-[22px] items-center rounded-full bg-clay/15 px-2 text-[11.5px] font-medium text-clay">失败</span>
  }
  if (task.status === 'downloading') {
    return <span className="inline-flex h-[22px] items-center rounded-full bg-copper/15 px-2 text-[11.5px] font-medium text-copper">下载中</span>
  }
  if (task.status === 'paused') {
    return <span className="inline-flex h-[22px] items-center rounded-full bg-line px-2 text-[11.5px] text-mist">已暂停</span>
  }
  return <span className="inline-flex h-[22px] items-center rounded-full bg-line px-2 text-[11.5px] text-mist">排队</span>
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-[12px] text-mist">{label}</span>
      <span className="max-w-[220px] text-right font-mono text-[11.5px] leading-snug text-fog">{value}</span>
    </div>
  )
}
