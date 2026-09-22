import { useEffect, useState, type CSSProperties } from 'react'
import './ui/wordmark.css'

/**
 * The NDM wordmark. It is still type set in Instrument Serif; what changes is
 * that it answers state instead of decorating. It reveals once on launch,
 * carries a thin accent line whose pace follows the live transfer rate, and
 * swells once when a download finishes. At rest it is perfectly still.
 */
export function Wordmark({ bytesPerSecond = 0, celebrating = false, size = 24, className = '', reveal = true }: {
  bytesPerSecond?: number
  celebrating?: boolean
  size?: number
  className?: string
  reveal?: boolean
}) {
  const [revealed, setRevealed] = useState(!reveal)
  useEffect(() => {
    if (revealed) return
    const timer = window.setTimeout(() => setRevealed(true), 700)
    return () => window.clearTimeout(timer)
  }, [revealed])

  const flowing = bytesPerSecond > 0
  // 100 KB/s reads as a slow drift; 20 MB/s as a quick sweep. Log scale so
  // the eye can tell "faster" without the line ever becoming a strobe.
  const duration = flowing ? Math.min(3.2, Math.max(0.7, 3.4 - Math.log10(Math.max(1, bytesPerSecond / 1024)) * 0.55)) : 0
  const style = { '--wordmark-size': `${size}px`, '--flow-duration': `${duration.toFixed(2)}s` } as CSSProperties

  return <span className={`wordmark ${className}`} style={style} data-reveal={reveal && !revealed ? 'true' : undefined}
    data-flow={flowing ? 'true' : undefined} data-celebrate={celebrating ? 'true' : undefined} aria-label="NDM" role="img">
    <span className="wordmark-glyphs" aria-hidden>NDM</span>
    <span className="wordmark-flow" aria-hidden />
  </span>
}
