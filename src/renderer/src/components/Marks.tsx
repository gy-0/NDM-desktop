import { AppWindow, Archive, File, FileImage, FileText, FileVideo, Music2, type LucideIcon } from 'lucide-react'
import type { DownloadCategory } from '../lib/types'

const marks: Record<DownloadCategory, LucideIcon> = {
  video: FileVideo,
  audio: Music2,
  document: FileText,
  compressed: Archive,
  application: AppWindow,
  image: FileImage,
  misc: File
}

export function TypeMark({ category, size = 'md' }: { category: DownloadCategory; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = marks[category]
  const box =
    size === 'lg' ? 'size-11 rounded-[13px]' : size === 'sm' ? 'size-9 rounded-[10px]' : 'size-10 rounded-[11px]'
  const iconSize = size === 'lg' ? 20 : size === 'sm' ? 16 : 18
  return (
    <span
      className={`grid shrink-0 place-items-center bg-raised text-fog shadow-[0_0_0_1px_var(--line)] ${box}`}
    >
      <Icon size={iconSize} strokeWidth={1.5} />
    </span>
  )
}
