import { ArrowDownToLine, ArrowLeft, CircleCheck, Clock3, Plus, Search } from 'lucide-react'
import type { FilterId } from '../lib/types'
import { WORKSPACE_LABELS } from '../lib/workspace'

export function EmptyState({ loading = false, filter, query = '', onNew, onClearSearch, onShowAll }: {
  loading?: boolean
  filter: FilterId
  query?: string
  onNew: () => void
  onClearSearch: () => void
  onShowAll: () => void
}) {
  if (loading) return (
    <div role="status" aria-live="polite" className="grid h-full min-h-[180px] place-items-center px-6 py-10">
      <div className="text-center">
        <Clock3 aria-hidden size={24} className="mx-auto text-mist" />
        <h2 className="mt-4 text-[15px] font-medium text-paper">正在读取任务库</h2>
        <p className="mt-2 text-[12.5px] text-mist">连接下载引擎后，你的任务会显示在这里。</p>
      </div>
    </div>
  )
  const searching = Boolean(query.trim())
  const firstRun = filter === 'all' && !searching
  const title = searching ? '没有找到匹配的下载'
    : firstRun ? '从一个链接开始'
    : filter === 'failed' ? '没有失败任务'
    : filter === 'active' ? '暂时没有正在下载的任务'
    : filter === 'queued' ? '等待队列为空'
    : filter === 'paused' ? '没有已暂停的任务'
    : filter === 'completed' ? '完成的下载会出现在这里' : `暂无${WORKSPACE_LABELS[filter]}下载`
  const Icon = searching ? Search : filter === 'failed' ? CircleCheck : filter === 'queued' ? Clock3 : ArrowDownToLine
  return (
    <div className="grid min-h-[260px] h-full place-items-center px-6 py-10">
      <div className="flex w-full max-w-[360px] flex-col items-center text-center">
        <div className="grid size-14 place-items-center rounded-2xl border border-line bg-raised/50 text-fog"><Icon aria-hidden size={24} strokeWidth={1.5} /></div>
        <h2 className="mt-5 text-[18px] font-semibold tracking-[-0.02em] text-paper">{title}</h2>
        <p className="mt-2 max-w-full break-words text-[12.5px] leading-5 text-mist">
          {searching ? `“${query.trim()}”在${WORKSPACE_LABELS[filter]}中没有匹配。试试更短的关键词，或清除搜索。`
            : firstRun ? '粘贴文件链接、视频网址或分享口令，也可以直接把链接拖进窗口。'
            : filter === 'failed' ? '当前没有需要重试的任务。其他下载仍可在全部下载中查看。'
            : '查看全部下载，或添加一个新任务。'}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button type="button" data-cuelume-press data-cuelume-release onClick={searching ? onClearSearch : firstRun ? onNew : onShowAll} className="inline-flex h-9 items-center gap-1.5 rounded-control bg-copper px-4 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90">
            {searching ? <Search size={14} aria-hidden /> : firstRun ? <Plus size={14} aria-hidden /> : <ArrowLeft size={14} aria-hidden />}
            {searching ? '清除搜索' : firstRun ? '添加下载' : '查看全部下载'}
          </button>
          {searching && filter !== 'all' ? <button type="button" onClick={onShowAll} className="h-9 rounded-control border border-line-strong px-3 text-[12.5px] text-fog hover:bg-raised hover:text-paper">在全部下载中搜索</button> : null}
        </div>
      </div>
    </div>
  )
}
