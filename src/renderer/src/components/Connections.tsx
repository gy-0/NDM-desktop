import type { Segment } from '../lib/types'

export function Connections({ segments, tall = false }: { segments: Segment[]; tall?: boolean }) {
  return (
    <div className={`flex ${tall ? 'h-10 gap-[3px]' : 'h-1.5 gap-[2px]'}`}>
      {segments.map((segment) => (
        <div key={segment.id} className="relative min-w-0 flex-1 overflow-hidden rounded-[2px] bg-line">
          <div
            className="absolute inset-y-0 left-0 bg-copper"
            style={{ width: `${Math.max(4, Math.round(segment.fraction * 100))}%` }}
          />
        </div>
      ))}
    </div>
  )
}
