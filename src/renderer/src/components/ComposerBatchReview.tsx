import { FileDown, ListChecks, X } from 'lucide-react'
import { batchLinkIdentity, type ComposerBatchLink } from '../lib/composerBatch'

export function ComposerBatchReview({ links, busy, completed, onRemove }: {
  links: ComposerBatchLink[]
  busy: boolean
  completed: number
  onRemove: (url: string) => void
}) {
  return (
    <section aria-label="待下载清单" className="mt-4 overflow-hidden rounded-xl border border-copper/20 bg-copper/[0.035]">
      <div className="flex items-center justify-between gap-3 border-b border-copper/10 px-3.5 py-3">
        <div className="flex items-center gap-2 text-[13px] font-medium text-paper"><ListChecks size={16} className="text-copper" aria-hidden />待下载清单</div>
        <span role="status" className="text-[12px] tabular-nums text-mist">{busy ? `正在添加 ${completed} / ${links.length}` : `${links.length} 项`}</span>
      </div>
      <ul className="max-h-[220px] overflow-y-auto divide-y divide-line/70 scroll-quiet">
        {links.map((item, index) => {
          const identity = batchLinkIdentity(item.url)
          return (
            <li key={item.url} data-batch-link className="flex min-w-0 items-center gap-3 px-3.5 py-2.5">
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-panel/60 text-fog"><FileDown size={16} strokeWidth={1.6} /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-paper" title={item.url}>{identity.title}</p>
                <p className={`mt-0.5 truncate text-[12px] ${item.failed ? 'text-clay' : 'text-mist'}`}>{item.failed ? '未能添加，可重试' : identity.detail}</p>
              </div>
              <button type="button" disabled={busy} aria-label={`移除第 ${index + 1} 项：${identity.title}`} title="从清单中移除" onClick={() => onRemove(item.url)} className="grid size-7 shrink-0 place-items-center rounded-lg text-mist transition-colors hover:bg-line hover:text-paper disabled:opacity-40"><X size={14} aria-hidden /></button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
