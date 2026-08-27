import type { Segment } from '../lib/types'
import type { ProgressStyle } from '../lib/presentationPrefs'
import { placeSegments } from '../lib/progressGeometry'

export function Connections({
  segments,
  fraction,
  fileSize = 0,
  style
}: {
  segments: Segment[]
  fraction: number
  fileSize?: number
  style: ProgressStyle
}) {
  const placed = placeSegments(segments, fileSize, fraction)
  const showSegments = style === 'segmented' && placed.length > 1
  return (
    <div
      role="progressbar"
      aria-label={showSegments ? `${placed.length} 个分段的下载进度` : '下载进度'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      className="relative h-1 overflow-hidden rounded-full bg-line shadow-[inset_0_0_0_1px_rgb(255_255_255/0.025)]"
      data-progress-style={showSegments ? 'segmented' : 'continuous'}
    >
      {showSegments ? (
        placed.map((segment) => (
          <div
            key={segment.id}
            className="absolute inset-y-0 overflow-hidden"
            style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
          >
            <div
              className="h-full w-full bg-copper transition-[transform] duration-150 ease-linear"
              style={{
                transform: `scaleX(${segment.fill})`,
                transformOrigin: 'left center'
              }}
            />
          </div>
        ))
      ) : (
        <div
          className="absolute inset-y-0 left-0 w-full bg-copper transition-[transform] duration-150 ease-linear"
          style={{
            transform: `scaleX(${Math.max(0, Math.min(1, fraction))})`,
            transformOrigin: 'left center'
          }}
        />
      )}
    </div>
  )
}
