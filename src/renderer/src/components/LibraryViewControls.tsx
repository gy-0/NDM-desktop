import { Popover } from '@base-ui/react/popover'
import { BookmarkPlus, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_VIEW_CRITERIA, VIEW_STATUS_OPTIONS, VIEW_TIME_OPTIONS, VIEW_TYPE_OPTIONS, viewCriteriaSummary, type LibraryViewCriteria, type SavedViewMutationResult } from '../lib/savedViews'
import type { TaskSort, TaskSortKey } from '../lib/taskList'
import './ui/saved-views.css'

export function LibraryViewControls({ criteria, onChange, onSave, activeViewName, onOpenChange, sort, onSort }: {
  criteria: LibraryViewCriteria
  sort: TaskSort
  onSort: (sort: TaskSort) => void
  onChange: (criteria: LibraryViewCriteria) => void
  onSave: (name: string) => SavedViewMutationResult
  activeViewName?: string
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const count = Number(criteria.status !== 'all') + Number(criteria.type !== 'all') + Number(criteria.time !== 'any')
  const summary = viewCriteriaSummary(criteria, false)
  const changeOpen = (next: boolean): void => {
    setOpen(next)
    onOpenChange?.(next)
    if (!next) { setNaming(false); setName(''); setError(null) }
  }
  useEffect(() => { if (naming) nameInput.current?.focus() }, [naming])

  return (
    <div className="library-view-controls app-no-drag" data-view-controls>
      <Popover.Root open={open} onOpenChange={changeOpen} modal="trap-focus">
        <Popover.Trigger className="library-view-trigger" aria-label="显示选项" data-active={count > 0 || undefined} title={count ? `显示选项 · ${summary}` : '显示选项 · 排序与筛选'}><SlidersHorizontal size={16} aria-hidden />{count > 0 ? <span className="library-view-count" aria-hidden>{count}</span> : null}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={8} align="end" className="z-[82] outline-none">
            <Popover.Popup className="library-filter-popup" data-library-filters>
              <div className="flex items-center justify-between gap-4">
                <Popover.Title className="text-[15px] font-semibold text-paper">{naming ? '保存常用视图' : '显示选项'}</Popover.Title>
                <Popover.Close aria-label="关闭显示选项" className="grid size-7 place-items-center rounded-control text-mist hover:bg-line"><X size={15} aria-hidden /></Popover.Close>
              </div>
              {naming ? (
                <form className="mt-3" onSubmit={event => {
                  event.preventDefault()
                  const result = onSave(name)
                  if (!result.ok) setError(result.error)
                  else changeOpen(false)
                }}>
                  <p className="mb-4 text-[13px] leading-relaxed text-mist">{viewCriteriaSummary(criteria)}</p>
                  <label className="grid gap-2 text-[13px] text-fog">视图名称<input ref={nameInput} aria-label="视图名称" maxLength={80} value={name} onChange={event => { setName(event.target.value); setError(null) }} placeholder="例如：本周设计素材" className="saved-view-input" aria-invalid={Boolean(error)} aria-describedby={error ? 'save-view-error' : undefined} /></label>
                  {error ? <p id="save-view-error" role="status" className="mt-2 text-[12px] text-clay">{error}</p> : null}
                  <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => { setNaming(false); setError(null) }} className="saved-view-secondary">返回</button><button type="submit" className="saved-view-primary" disabled={!name.trim()}>保存视图</button></div>
                </form>
              ) : (
                <>
                  <div className="library-order-fields">
                    <label className="library-filter-field"><span>排列方式</span><select aria-label="排列方式" value={sort.key} onChange={event => {
                      const key = event.target.value as TaskSortKey
                      onSort({ key, direction: key === 'filename' || key === 'status' ? 'asc' : 'desc' })
                    }}>
                      <option value="activity">最近活动</option><option value="filename">文件名</option><option value="size">文件大小</option><option value="progress">下载进度</option><option value="status">任务状态</option>
                    </select></label>
                    <label className="library-filter-field"><span>顺序</span><select aria-label="排列顺序" value={sort.direction} onChange={event => onSort({ ...sort, direction: event.target.value as TaskSort['direction'] })}>
                      <option value="asc">{sort.key === 'filename' ? 'A → Z' : sort.key === 'activity' ? '最早在前' : sort.key === 'status' ? '进行中在前' : '从小到大'}</option>
                      <option value="desc">{sort.key === 'filename' ? 'Z → A' : sort.key === 'activity' ? '最新在前' : sort.key === 'status' ? '已完成在前' : '从大到小'}</option>
                    </select></label>
                  </div>
                  <div className="mt-3 grid gap-3">
                    <p className="library-filter-section-label">筛选</p>
                    <label className="library-filter-field"><span>状态</span><select aria-label="筛选状态" value={criteria.status} onChange={event => onChange({ ...criteria, status: event.target.value as LibraryViewCriteria['status'] })}>{VIEW_STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                    <label className="library-filter-field"><span>类型</span><select aria-label="筛选类型" value={criteria.type} onChange={event => onChange({ ...criteria, type: event.target.value as LibraryViewCriteria['type'] })}>{VIEW_TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                    <label className="library-filter-field"><span>最近活动</span><select aria-label="最近活动时间" value={criteria.time} onChange={event => onChange({ ...criteria, time: event.target.value as LibraryViewCriteria['time'] })}>{VIEW_TIME_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                  </div>
                  {criteria.time !== 'any' ? <p className="mt-2 text-[12px] leading-relaxed text-mist">按任务最近活动筛选，包含今天。</p> : null}
                  {criteria.query.trim() ? <p className="mt-3 truncate text-[12px] text-mist" title={criteria.query}>关键词：{criteria.query}</p> : null}
                  {activeViewName ? <p className="mt-3 text-[12px] text-mist">当前视图：{activeViewName}</p> : null}
                  <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3">
                    <button type="button" className="saved-view-secondary" onClick={() => onChange({ ...DEFAULT_VIEW_CRITERIA })} disabled={count === 0 && !criteria.query}>重置筛选</button>
                    <button type="button" className="saved-view-secondary flex items-center gap-1.5" onClick={() => { setNaming(true); setName(''); setError(null) }}><BookmarkPlus size={14} aria-hidden />保存视图…</button>
                  </div>
                </>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

/** Only non-obvious combined filters need a summary beside the title. */
export function LibraryViewSummary({ criteria, onChange, activeViewName }: {
  criteria: LibraryViewCriteria
  onChange: (criteria: LibraryViewCriteria) => void
  activeViewName?: string
}) {
  const count = Number(criteria.status !== 'all') + Number(criteria.type !== 'all') + Number(criteria.time !== 'any')
  if (!count || (count === 1 && criteria.time === 'any' && !activeViewName)) return null
  const summary = viewCriteriaSummary(criteria, false)
  return <span className="library-view-summary" title={summary}><span className="truncate">{summary}</span><button type="button" aria-label="清除组合筛选" title="清除状态、类型与时间筛选" onClick={() => onChange({ ...DEFAULT_VIEW_CRITERIA, query: criteria.query })}><X size={12} aria-hidden /></button></span>
}
