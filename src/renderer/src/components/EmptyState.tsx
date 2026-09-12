import { ArrowDownToLine, ArrowLeft, CircleCheck, Clock3, Plus, Search } from 'lucide-react'
import type { FilterId } from '../lib/types'
import { WORKSPACE_LABELS } from '../lib/workspace'
import './ui/empty-state.css'

export function EmptyState({ loading = false, filter, query = '', onNew, onClearSearch, onShowAll, constrained = false }: {
  loading?: boolean
  filter: FilterId
  query?: string
  constrained?: boolean
  onNew: () => void
  onClearSearch: () => void
  onShowAll: () => void
}) {
  if (loading) return (
    <div role="status" aria-live="polite" className="grid h-full min-h-[180px] place-items-center px-6 py-10">
      <div className="text-center">
        <Clock3 aria-hidden size={24} className="mx-auto text-mist" />
        <h2 className="mt-4 text-[15px] font-medium text-paper">正在读取任务库</h2>
        <p className="empty-state-copy mt-2 text-[12.5px] leading-5 text-mist">连接下载引擎后，你的任务会显示在这里。</p>
      </div>
    </div>
  )
  const searching = Boolean(query.trim())
  const firstRun = filter === 'all' && !searching && !constrained
  const title = searching || constrained ? '没有找到匹配的下载'
    : firstRun ? '从一个链接开始'
    : filter === 'failed' ? '没有失败任务'
    : filter === 'active' ? '暂时没有正在下载的任务'
    : filter === 'queued' ? '等待队列为空'
    : filter === 'paused' ? '没有已暂停的任务'
    : filter === 'completed' ? '完成的下载会出现在这里' : `暂无${WORKSPACE_LABELS[filter]}下载`
  const Icon = searching || constrained ? Search : filter === 'failed' ? CircleCheck : filter === 'queued' ? Clock3 : ArrowDownToLine
  return (
    <div data-empty-state className="grid min-h-[260px] h-full place-items-center px-6 py-10">
      <div className="empty-state-content flex w-full max-w-[360px] flex-col items-center text-center">
        <div className="grid size-14 place-items-center rounded-2xl border border-line bg-raised/50 text-fog"><Icon aria-hidden size={24} strokeWidth={1.5} /></div>
        <h2 className="empty-state-copy mt-5 text-[18px] font-semibold tracking-[-0.02em] text-paper">{title}</h2>
        <p className="empty-state-copy mt-2 max-w-full text-[12.5px] leading-5 text-mist">
          {searching ? <><span className="empty-state-query" title={query.trim()}>未在{constrained ? '当前筛选结果' : WORKSPACE_LABELS[filter]}中找到“{query.trim()}”。</span><span>试试更短的关键词，或清除搜索。</span></>
            : constrained ? <><span>当前筛选条件下没有匹配的任务。</span><span>调整筛选，或查看全部下载。</span></>
            : firstRun ? <><span>粘贴文件链接、视频网址或分享口令。</span><span>也可以把链接直接拖到这里。</span></>
            : filter === 'failed' ? <><span>当前没有需要重试的任务。</span><span>可以在全部下载中查看其他任务。</span></>
            : filter === 'active' ? <><span>下载开始后，可以在这里查看进度。</span><span>已暂停或完成的任务仍在全部下载中。</span></>
            : filter === 'queued' ? <><span>等待开始的任务会显示在这里。</span><span>查看全部下载，了解其他任务的状态。</span></>
            : filter === 'paused' ? <><span>暂停下载后，可以在这里继续。</span><span>查看全部下载，了解其他任务的状态。</span></>
            : filter === 'completed' ? <><span>下载完成后，可用空格预览文件。</span><span>查看全部下载，了解任务进度。</span></>
            : '试试其他文件类型，或查看全部下载。'}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button type="button" data-cuelume-press data-cuelume-release onClick={searching ? onClearSearch : firstRun ? onNew : onShowAll} className="inline-flex h-9 items-center gap-1.5 rounded-control bg-copper px-4 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90">
            {searching ? <Search size={14} aria-hidden /> : firstRun ? <Plus size={14} aria-hidden /> : <ArrowLeft size={14} aria-hidden />}
            {searching ? '清除搜索' : firstRun ? '添加下载' : '查看全部下载'}
          </button>
          {searching && (filter !== 'all' || constrained) ? <button type="button" onClick={onShowAll} className="h-9 rounded-control border border-line-strong px-3 text-[12.5px] text-fog hover:bg-raised hover:text-paper">在全部下载中搜索</button> : null}
        </div>
      </div>
    </div>
  )
}
