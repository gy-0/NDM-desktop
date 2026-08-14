import type { DownloadCategory } from '../lib/types'

const marks: Record<DownloadCategory, string> = {
  video: '影',
  audio: '声',
  document: '文',
  compressed: '包',
  application: '用',
  image: '图',
  misc: '件'
}

export function TypeMark({ category, size = 'md' }: { category: DownloadCategory; size?: 'sm' | 'md' | 'lg' }) {
  const box =
    size === 'lg' ? 'h-14 w-14 text-[18px]' : size === 'sm' ? 'h-8 w-8 text-[11px]' : 'h-10 w-10 text-[13px]'
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-[10px] border border-line bg-raised font-serif text-fog ${box}`}
    >
      {marks[category]}
    </span>
  )
}
