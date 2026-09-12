import { Popover } from '@base-ui/react/popover'
import { ArrowDownToLine, ArrowUpRight, Clock3, CircleAlert, LoaderCircle, Pause, Radio } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { formatSpeed } from '../lib/format'
import './ui/transfer-control.css'

export type TransferControlProps = {
  children?: ReactNode
  temporaryLabel?: string
  activeCount: number
  liveCount: number
  waitingCount?: number
  bytesPerSecond: number
  busy?: boolean
  error?: string
  onPauseAll: () => void
  onShowActive?: () => void
}

export function TransferControl({
  activeCount, liveCount, waitingCount = 0, bytesPerSecond,
  busy = false, error, onPauseAll, onShowActive, temporaryLabel, children
}: TransferControlProps) {
  const [open, setOpen] = useState(false)
  const errorId = useId()
  const active = Math.max(0, Math.floor(activeCount))
  const live = Math.min(active, Math.max(0, Math.floor(liveCount)))
  const waiting = Math.max(0, Math.floor(waitingCount))
  const ordinary = active - live
  const rate = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0
  const speed = rate >= 1024 ** 3
    ? { value: (rate / 1024 ** 3).toFixed(1), unit: 'GB/s' }
    : formatSpeed(rate)
  const speedLabel = `${speed.value} ${speed.unit}`
  const fullLabel = active > 0
    ? `传输：${active} 项进行中${live ? `，其中 ${live} 项直播` : ''} · ${speedLabel}${waiting ? ` · ${waiting} 项等待中` : ''}`
    : `传输${waiting ? ` · ${waiting} 项等待中` : ' · 当前没有进行中的下载'}`
  const pauseLabel = live > 0 ? '暂停下载并保存直播' : '暂停所有下载'

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="transfer-control-trigger h-control text-label" data-transfer-control aria-label="传输状态" title={temporaryLabel ? `${fullLabel} · ${temporaryLabel}` : fullLabel}>
        <span className="transfer-control-icon" data-temporary={temporaryLabel || undefined}>{temporaryLabel ? <Clock3 size={14} aria-hidden /> : <ArrowDownToLine size={14} aria-hidden />}</span>
        {active > 0 ? (
          <>
            <span className="transfer-control-count tabular-nums" aria-label={`${active} 项进行中`}>{active > 99 ? '99+' : active}</span>
            <span className="transfer-control-speed tabular-nums" aria-hidden><span>{speed.value}</span><span className="text-meta">{speed.unit}</span></span>
          </>
        ) : <span className="transfer-control-idle">传输</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={9} align="start" collisionPadding={12} className="transfer-control-positioner">
          <Popover.Popup className="transfer-control-popup" aria-describedby={error ? errorId : undefined} onKeyDown={(event) => {
            // The open popover owns keys; Space must not preview a selected
            // download underneath an idle popup with no action buttons.
            if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
            event.stopPropagation()
          }}>
            <div className="transfer-control-heading">
              <Popover.Title className="text-body font-medium text-paper">{active > 0 ? '正在传输' : '传输'}</Popover.Title>
              {onShowActive && (active > 0 || waiting > 0) ? (
                <button type="button" className="transfer-control-view text-label" onClick={() => { setOpen(false); onShowActive() }}>
                  查看任务 <ArrowUpRight size={12} aria-hidden />
                </button>
              ) : null}
            </div>
            {active > 0 ? (
              <>
                <p className="transfer-control-total" aria-live="off"><span>{speed.value}</span><span className="text-label">{speed.unit}</span></p>
                <dl className="transfer-control-counts text-label">
                  {ordinary > 0 ? <div><dt>文件下载</dt><dd>{ordinary} 项</dd></div> : null}
                  {live > 0 ? <div><dt><Radio size={12} aria-hidden />直播录制</dt><dd>{live} 项</dd></div> : null}
                  {waiting > 0 ? <div><dt>等待中</dt><dd>{waiting} 项</dd></div> : null}
                </dl>
              </>
            ) : (
              <div className="transfer-control-empty text-label">
                <p>当前没有进行中的下载</p>
                {waiting > 0 ? <p className="mt-1 text-mist">{waiting} 项等待中</p> : null}
              </div>
            )}
            {live > 0 ? <p className="transfer-control-live-note text-meta">直播会在停止后保存为文件。</p> : null}
            {children}
            {active > 0 || waiting > 0 || busy ? (
              <div className="transfer-control-footer">
                <button type="button" className="transfer-control-pause h-field text-label" disabled={busy} aria-busy={busy} aria-describedby={error ? errorId : undefined} onClick={onPauseAll}>
                  {busy ? <LoaderCircle size={13} aria-hidden className="animate-spin" /> : <Pause size={13} aria-hidden />}
                  {busy ? '正在处理…' : pauseLabel}
                </button>
              </div>
            ) : null}
            {error ? <p id={errorId} role="status" aria-live="polite" className="transfer-control-error text-label"><CircleAlert size={13} aria-hidden /><span>{error}</span></p> : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
