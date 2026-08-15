import type { Segment } from '../lib/types'

export function Connections({ segments, tall = false }: { segments: Segment[]; tall?: boolean }) {
  return (
    <div className={`flex ${tall ? 'h-1.5 gap-[3px]' : 'h-1 gap-[2px]'}`}>
      {segments.map((segment) => (
        <div key={segment.id} className="relative min-w-0 flex-1 overflow-hidden rounded-full bg-line">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-copper transition-[transform] duration-150 ease-out"
            style={{
              width: '100%',
              transform: `scaleX(${Math.max(0.04, segment.fraction)})`,
              transformOrigin: 'left center'
            }}
          />
        </div>
      ))}
    </div>
  )
}
