import { Dialog } from '@base-ui/react/dialog'
import { AppWindow, ArrowDown, ArrowUp, CornerDownLeft, File, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { filterCommands, nextCommandId, type SearchableCommand } from '../lib/commandSearch'

export interface CommandPaletteItem extends SearchableCommand {
  scope?: 'workspace' | 'selection'
  shortcut?: string
  onSelect: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  items: CommandPaletteItem[]
  selectionLabel?: string
}

export function CommandPalette({ open, onClose, items, selectionLabel }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const executed = useRef(false)
  const followActive = useRef(true)
  const id = useId()
  const listId = `${id}-commands`
  const contextId = `${id}-context`
  const filtered = useMemo(() => filterCommands(items, query), [items, query])
  const groups = [
    { scope: 'selection', title: '当前所选', icon: File, items: filtered.filter((item) => item.scope === 'selection') },
    { scope: 'workspace', title: '工作区', icon: AppWindow, items: filtered.filter((item) => item.scope !== 'selection') }
  ] as const
  const ordered = groups.flatMap((group) => group.items)
  const active = ordered.find((item) => item.id === activeId && !item.disabled) ?? ordered.find((item) => !item.disabled)
  const optionId = (itemId: string): string => `${id}-command-${encodeURIComponent(itemId)}`

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveId(null)
    executed.current = false
    followActive.current = true
  }, [open])

  useEffect(() => {
    if (!open || !active || !followActive.current) return
    document.getElementById(optionId(active.id))?.scrollIntoView({ block: 'nearest' })
  }, [open, active?.id])

  function select(item: CommandPaletteItem): void {
    if (item.disabled || executed.current) return
    executed.current = true
    onClose()
    // Let the dialog release its focus scope before the existing action opens
    // another surface or moves focus to the workspace search field.
    window.requestAnimationFrame(item.onSelect)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.key === 'Process' || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      followActive.current = true
      setActiveId(nextCommandId(ordered, active?.id ?? null, event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat && active) select(active)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="workspace-dialog-backdrop" />
        <Dialog.Viewport className="workspace-dialog-viewport" style={{ placeItems: 'start center', paddingTop: 'clamp(24px, 13vh, 104px)' }}>
          <Dialog.Popup
            data-command-palette
            initialFocus={input}
            finalFocus={() => executed.current ? false : true}
            aria-describedby={selectionLabel ? contextId : undefined}
            className="workspace-dialog-popup flex w-[min(620px,100%)] flex-col overflow-hidden rounded-2xl border border-line-strong bg-raised shadow-dialog"
            style={{ maxHeight: 'min(580px, calc(100dvh - 128px))', backgroundImage: 'linear-gradient(160deg, var(--control-sheen), transparent 38%)' }}
          >
            <div className="shrink-0 border-b border-line px-5 pt-4 pb-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Dialog.Title className="text-[16px] font-semibold tracking-[-0.01em] text-paper">快速操作</Dialog.Title>
                <Dialog.Close aria-label="关闭快速操作" className="rounded-md p-1 text-mist transition-colors hover:bg-line hover:text-paper">
                  <X size={16} aria-hidden="true" />
                </Dialog.Close>
              </div>
              <div className="flex items-center gap-3">
                <Search size={19} strokeWidth={1.7} className="shrink-0 text-fog" aria-hidden="true" />
                <input
                  ref={input}
                  role="combobox"
                  aria-label="搜索操作"
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-activedescendant={active ? optionId(active.id) : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(event) => { followActive.current = true; setQuery(event.target.value); setActiveId(null) }}
                  onKeyDown={onKeyDown}
                  placeholder="搜索操作，例如预览、复制链接…"
                  className="min-w-0 flex-1 bg-transparent py-1 text-[16px] leading-6 text-paper outline-none placeholder:text-mist"
                />
                {query ? <button type="button" aria-label="清空操作搜索" onClick={() => { followActive.current = true; setQuery(''); setActiveId(null); input.current?.focus() }} className="rounded-md p-1 text-mist hover:bg-line hover:text-paper"><X size={14} aria-hidden="true" /></button> : null}
              </div>
            </div>

            {selectionLabel ? (
              <p id={contextId} data-command-context className="flex min-w-0 shrink-0 items-center gap-2 border-b border-line/60 bg-panel/40 px-5 py-2.5 text-[13px] leading-5 text-fog">
                <File size={14} className="shrink-0 text-mist" aria-hidden="true" />
                <span className="shrink-0 text-mist">所选文件</span>
                <span title={selectionLabel} className="truncate font-medium">{selectionLabel}</span>
              </p>
            ) : null}

            <div id={listId} role="listbox" aria-label="可用操作" className="scroll-quiet min-h-32 overflow-y-auto p-2">
              {groups.map((group) => group.items.length > 0 ? (
                <div key={group.scope} role="group" aria-labelledby={`${id}-${group.scope}`} className="mb-1 last:mb-0">
                  <div id={`${id}-${group.scope}`} className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-[12px] font-medium text-mist">
                    <group.icon size={13} aria-hidden="true" />{group.title}
                  </div>
                  {group.items.map((item) => {
                    const isActive = active?.id === item.id
                    return <button
                      key={item.id}
                      id={optionId(item.id)}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={item.disabled || undefined}
                      disabled={item.disabled}
                      tabIndex={-1}
                      data-command-id={item.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onPointerMove={() => { if (!item.disabled) { followActive.current = false; setActiveId(item.id) } }}
                      onClick={() => select(item)}
                      className="flex w-full items-center gap-4 rounded-lg border px-3 py-2.5 text-left transition-colors duration-100 disabled:cursor-default disabled:opacity-40 motion-reduce:transition-none"
                      style={{
                        borderColor: isActive ? 'var(--selection-edge, var(--line-strong))' : 'transparent',
                        background: isActive ? 'linear-gradient(155deg, var(--control-sheen), transparent 58%), var(--selection-wash)' : 'transparent',
                        boxShadow: isActive ? 'inset 0 1px 0 var(--control-sheen)' : 'none'
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[16px] font-medium leading-6 text-paper">{item.label}</span>
                        {item.detail ? <span className="mt-0.5 block truncate text-[12.5px] leading-5 text-mist">{item.detail}</span> : null}
                      </span>
                      {item.shortcut ? <kbd className="shrink-0 rounded-md border border-line-strong bg-panel/50 px-1.5 py-0.5 font-sans text-[12px] leading-5 text-fog">{item.shortcut}</kbd> : <CornerDownLeft size={15} className={`shrink-0 text-fog ${isActive ? '' : 'invisible'}`} aria-hidden="true" />}
                    </button>
                  })}
                </div>
              ) : null)}
              {ordered.length === 0 ? <div role="status" className="px-4 py-9 text-center">
                <p className="text-[15px] font-medium text-paper">没有找到这个操作</p>
                <p className="mt-2 text-[13px] leading-5 text-mist">换个关键词试试，例如“设置”。</p>
              </div> : null}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-4 border-t border-line px-5 py-3 text-[12px] leading-4 text-mist">
              <span className="inline-flex items-center gap-1.5"><ArrowUp size={12} aria-hidden="true" /><ArrowDown size={12} aria-hidden="true" />选择<span className="ml-3 inline-flex items-center gap-1.5"><CornerDownLeft size={13} aria-hidden="true" />执行</span></span>
              <span className="flex items-center gap-3"><span className="tabular-nums">{ordered.length} 项</span><span><kbd className="font-sans">Esc</kbd> 关闭</span></span>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
