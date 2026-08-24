import { ArrowDownToLine, Plus } from 'lucide-react'

export function EmptyState({
  filter,
  onNew
}: {
  filter: string
  onNew: () => void
}) {
  const firstRun = filter === 'all'

  return (
    <div className="grid h-full place-items-center px-8 py-16">
      <div className="flex max-w-[320px] flex-col items-center text-center">
        <ArrowDownToLine aria-hidden size={28} strokeWidth={1.45} className="text-mist" />
        <h2 className="mt-4 text-[16px] font-semibold tracking-[-0.01em] text-paper">
          {firstRun ? '暂无下载' : '此分类为空'}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-5 text-mist">
          {firstRun ? '粘贴链接，或将链接文件拖到窗口' : '切换分类，或新建一个下载任务'}
        </p>
        <div className="mt-5">
          <button
            type="button"
            data-cuelume-press
            data-cuelume-release
            onClick={onNew}
            className="inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-copper px-3.5 text-[12.5px] font-medium text-on-accent transition-[opacity,transform] duration-100 active:translate-y-px"
          >
            <Plus size={14} strokeWidth={2} />
            新建下载
          </button>
        </div>
      </div>
    </div>
  )
}
