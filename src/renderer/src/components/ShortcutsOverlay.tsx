import { Dialog } from '@base-ui/react/dialog'
import { Keyboard, X } from 'lucide-react'
import { COMMAND_KEY, FILE_MANAGER, IS_WINDOWS } from '../lib/platform'
import { cue } from '../lib/sound'

type Shortcut = { keys: string[]; label: string }

const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: '工作区',
    items: [
      { keys: [COMMAND_KEY, 'N'], label: '新建下载' },
      { keys: [COMMAND_KEY, 'F'], label: '搜索任务' },
      { keys: ['/'], label: '快速搜索' },
      { keys: [COMMAND_KEY, ','], label: '设置' },
      { keys: ['?'], label: '快捷键速查' }
    ]
  },
  {
    title: '选中任务',
    items: [
      { keys: ['↑', '↓'], label: '移动选择' },
      { keys: ['Shift', '↑ / ↓'], label: '连续扩选或缩选' },
      { keys: ['Space'], label: IS_WINDOWS ? '打开文件预览' : '快速预览' },
      { keys: ['Enter'], label: '打开 / 暂停 / 继续' },
      { keys: [COMMAND_KEY, 'C'], label: '复制下载链接' },
      { keys: [COMMAND_KEY, 'R'], label: `在${FILE_MANAGER}中显示` }
    ]
  },
  {
    title: '批量与清理',
    items: [
      { keys: [COMMAND_KEY, 'A'], label: '全选当前可见任务' },
      { keys: ['Delete'], label: '选择如何移除任务' },
      { keys: [COMMAND_KEY, IS_WINDOWS ? 'Backspace' : '⌫'], label: '确认移除任务与文件' },
      { keys: ['Esc'], label: '取消选择 / 关闭浮层' }
    ]
  }
]

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  function close(): void {
    onClose()
    cue('release')
  }
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) close() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="workspace-dialog-backdrop" />
        <Dialog.Viewport className="workspace-dialog-viewport">
          <Dialog.Popup className="workspace-dialog-popup w-[min(600px,100%)] rounded-xl border border-line-strong bg-raised shadow-dialog">
            <div className="flex items-start justify-between gap-4 px-6 pt-6">
              <div>
                <Dialog.Title className="flex items-center gap-2 text-[19px] font-semibold leading-tight text-paper">
                  <Keyboard size={18} className="text-fog" aria-hidden="true" />键盘快捷键
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-[12px] text-mist">少一点点击，更快找到和管理下载。</Dialog.Description>
              </div>
              <Dialog.Close aria-label="关闭快捷键" className="shrink-0 rounded-lg p-1.5 text-mist transition-colors hover:bg-line hover:text-paper">
                <X size={16} aria-hidden="true" />
              </Dialog.Close>
            </div>
            <div className="grid gap-x-8 gap-y-6 px-6 py-6 sm:grid-cols-2">
              {GROUPS.map((group) => (
                <section key={group.title}>
                  <h3 className="mb-3 text-[11px] font-semibold text-mist">{group.title}</h3>
                  <dl className="space-y-2.5">
                    {group.items.map((item) => (
                      <div key={item.label} className="flex items-center justify-between gap-3 text-[12px] text-fog">
                        <dt>{item.label}</dt>
                        <dd className="flex shrink-0 items-center gap-1">
                          {item.keys.map((key) => <kbd key={key} className="grid min-w-6 place-items-center rounded border border-line-strong bg-panel px-1.5 py-0.5 font-mono text-[10px] text-paper">{key}</kbd>)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
            <p className="border-t border-line px-6 py-3 text-[11px] leading-relaxed text-mist">搜索框内 Esc 先清空搜索；删除操作始终需要确认。输入文字时不会触发任务操作。</p>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
