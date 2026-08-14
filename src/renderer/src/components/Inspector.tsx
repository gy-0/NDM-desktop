import { FolderOpen, Pause, Play, Trash2 } from 'lucide-react'
import { formatBytes, formatEta, fractionOf, remainingSeconds } from '../lib/format'
import { remove, toggle } from '../lib/store'
import { CATEGORY_LABEL, PHASE_LABEL, STATUS_LABEL, type Task } from '../lib/types'
import { Connections } from './Connections'

export function Inspector({ task, onClose }: { task: Task; onClose: () => void }) {
  const fraction = fractionOf(task)
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center justify-between px-5 pb-3 pt-[56px]">
        <div className="text-[11px] uppercase tracking-[0.16em] text-mist">详情</div>
        <button type="button" data-cuelume-press="droplet" onClick={onClose} className="text-[12px] text-fog">
          关闭
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 pb-6 scroll-quiet">
        <h2 className="font-serif text-[26px] leading-tight">{task.title}</h2>
        <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-mist">{task.url}</p>

        <dl className="mt-6 space-y-3 text-[13px]">
          <Fact label="状态" value={STATUS_LABEL[task.status]} />
          {task.phase ? <Fact label="阶段" value={PHASE_LABEL[task.phase]} /> : null}
          <Fact label="类型" value={CATEGORY_LABEL[task.category]} />
          <Fact label="大小" value={`${formatBytes(task.completedBytes)} / ${formatBytes(task.fileSize)}`} />
          <Fact label="进度" value={`${Math.round(fraction * 100)}%`} />
          {task.status === 'downloading' ? (
            <Fact label="剩余" value={formatEta(remainingSeconds(task))} />
          ) : null}
          <Fact label="连接" value={`${task.connections} 个`} />
          <Fact label="位置" value={task.folderPath} />
        </dl>

        {task.errorText ? (
          <p className="mt-5 rounded-lg border border-clay/30 bg-clay/10 px-3 py-2 text-[12px] leading-relaxed text-paper">
            {task.errorText}
          </p>
        ) : null}

        <div className="mt-6">
          <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-mist">连接进度</div>
          <Connections segments={task.segments} tall />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-line p-4">
        <Action
          icon={task.status === 'downloading' ? Pause : Play}
          label={task.status === 'downloading' ? '暂停' : '继续'}
          onClick={() => toggle(task.id)}
        />
        <Action icon={FolderOpen} label="访达" />
        <Action icon={Trash2} label="删除" tone="danger" onClick={() => { remove(task.id); onClose() }} />
      </div>
    </aside>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-mist">{label}</dt>
      <dd className="max-w-[180px] text-right leading-snug">{value}</dd>
    </div>
  )
}

function Action({
  icon: Icon,
  label,
  onClick,
  tone
}: {
  icon: typeof Pause
  label: string
  onClick?: () => void
  tone?: 'danger'
}) {
  return (
    <button
      type="button"
      data-cuelume-press={tone === 'danger' ? 'droplet' : 'press'}
      data-cuelume-release
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-lg border border-line py-2 text-[11px] transition-transform duration-150 active:scale-[0.96] ${
        tone === 'danger' ? 'text-clay' : 'text-fog'
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  )
}
