import type { ReactNode } from 'react'

/**
 * One settings row: what it is on the left, the control on the right, and an
 * optional status line that stays in the accessibility tree even when empty.
 * `layout="stacked"` puts a wide control (segmented, slider) under the text.
 */
export function SettingRow({ title, description, control, status, statusId, layout = 'inline', icon, children }: {
  title: ReactNode
  description?: ReactNode
  control?: ReactNode
  status?: string
  statusId?: string
  layout?: 'inline' | 'stacked'
  icon?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="setting-row" data-layout={layout}>
      <div className="setting-row-main">
        {icon ? <span className="setting-row-icon" aria-hidden>{icon}</span> : null}
        <div className="setting-row-text">
          <span className="setting-row-title">{title}</span>
          {description ? <span className="setting-row-description">{description}</span> : null}
        </div>
        {control && layout === 'inline' ? <div className="setting-row-control">{control}</div> : null}
      </div>
      {control && layout === 'stacked' ? <div className="setting-row-control">{control}</div> : null}
      {children}
      {statusId !== undefined || status ? (
        <p id={statusId} role="status" aria-live="polite" className={status ? 'setting-row-status' : 'sr-only'}>{status}</p>
      ) : null}
    </div>
  )
}
