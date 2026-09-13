import { LayoutGrid, List } from 'lucide-react'
import './ui/library-layout.css'

export type LibraryLayout = 'list' | 'cards'

export function readLibraryLayout(): LibraryLayout {
  try { return localStorage.getItem('ndm.library-layout') === 'list' ? 'list' : 'cards' } catch { return 'cards' }
}

export function LibraryLayoutSwitch({ value, onChange }: { value: LibraryLayout; onChange: (value: LibraryLayout) => void }) {
  return <div className="library-layout-switch" role="group" aria-label="文件视图" data-layout={value}>
    <span className="library-layout-highlight" aria-hidden />
    <button type="button" aria-label="卡片视图" aria-pressed={value === 'cards'} onClick={() => onChange('cards')}><LayoutGrid size={14} /><span>卡片</span></button>
    <button type="button" aria-label="列表视图" aria-pressed={value === 'list'} onClick={() => onChange('list')}><List size={15} /><span>列表</span></button>
  </div>
}
