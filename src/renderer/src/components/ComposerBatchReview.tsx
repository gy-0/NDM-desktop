import { FileDown, ListChecks, LoaderCircle, X } from 'lucide-react'
import { batchLinkIdentity, type ComposerBatchLink } from '../lib/composerBatch'

export function ComposerBatchReview({ links, busy, confirming, completed, onRemove, onDiscard }: {
  links: ComposerBatchLink[]
  busy: boolean
  confirming: boolean
  completed: number
  onRemove: (url: string) => void
  onDiscard?: () => void
}) {
  return (
    <section aria-label="待下载清单" className="mt-4 overflow-hidden rounded-xl border border-copper/20 bg-copper/[0.035]">
      <div className="flex items-center justify-between gap-3 border-b border-copper/10 px-3.5 py-3">
        <div className="flex items-center gap-2 text-[13px] font-medium text-paper"><ListChecks size={16} className="text-copper" aria-hidden />待下载清单</div>
        <div className="flex items-center gap-3 text-[12px] text-mist"><span role="status" className="tabular-nums">{busy ? `已处理 ${completed} 项` : `${links.length} 项`}</span>{onDiscard ? <button type="button" onClick={onDiscard} disabled={busy || links.some(item => item.status === 'unconfirmed')} className="transition-colors hover:text-paper disabled:opacity-40">丢弃清单</button> : null}</div>
      </div>
      <ul className="max-h-[220px] overflow-y-auto divide-y divide-line/70 scroll-quiet">
        {!links.length ? <li className="px-3.5 py-4 text-[13px] text-mist">加入链接，准备下一批下载。</li> : null}
        {links.map((item, index) => {
          const identity = batchLinkIdentity(item.url)
          const unconfirmed = item.status === 'unconfirmed'
          const failed = item.status === 'failed' || item.failed
          return (
            <li key={item.url} data-batch-link className="flex min-w-0 items-center gap-3 px-3.5 py-2.5">
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-panel/60 text-fog"><FileDown size={16} strokeWidth={1.6} /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-paper" title={item.url}>{identity.title}</p>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px]">
                  <span className="truncate text-mist">{identity.detail}</span>
                  {unconfirmed || failed ? <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors duration-150 ${failed ? 'bg-clay/8 text-clay' : 'bg-line text-fog'}`}>
                    {unconfirmed && busy ? <LoaderCircle size={11} className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                    {unconfirmed ? busy ? confirming ? '确认中…' : '正在添加…' : '待确认' : '未能添加，可重试'}
                  </span> : null}
                </div>
              </div>
              <button type="button" disabled={busy || item.status === 'unconfirmed'} aria-label={`移除第 ${index + 1} 项：${identity.title}`} title={item.status === 'unconfirmed' ? '确认添加结果后可移除' : '从清单中移除'} onClick={() => onRemove(item.url)} className="grid size-7 shrink-0 place-items-center rounded-lg text-mist transition-colors hover:bg-line hover:text-paper disabled:opacity-40"><X size={14} aria-hidden /></button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
