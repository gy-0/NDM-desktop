import type { Segment } from '../lib/types'
import type { ProgressStyle } from '../lib/presentationPrefs'

export function Connections({
  segments,
  fraction,
  style
}: {
  segments: Segment[]
  fraction: number
  style: ProgressStyle
}) {
  const showSegments = style === 'segmented' && segments.length > 1
  return (
    <div
      role="progressbar"
      aria-label={showSegments ? `${segments.length} 个并行分段的下载进度` : '下载进度'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      className="flex h-1 overflow-hidden rounded-full bg-line shadow-[inset_0_0_0_1px_rgb(255_255_255/0.025)]"
      data-progress-style={showSegments ? 'segmented' : 'continuous'}
    >
      {(showSegments ? segments : [{ id: -1, fraction }]).map((segment, index, rows) => (
        <div
          key={segment.id}
          className="relative min-w-0 flex-1 overflow-hidden"
          style={index < rows.length - 1 ? { boxShadow: 'inset -1px 0 rgb(0 0 0 / 0.16)' } : undefined}
        >
          <div
            className="absolute inset-y-0 left-0 w-full bg-copper transition-[transform] duration-150 ease-linear"
            style={{
              transform: `scaleX(${Math.max(0, Math.min(1, segment.fraction))})`,
              transformOrigin: 'left center'
            }}
          />
        </div>
      ))}
    </div>
  )
}
