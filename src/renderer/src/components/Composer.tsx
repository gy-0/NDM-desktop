import { useState } from 'react'
import { addFromUrl } from '../lib/store'

export function Composer({
  open,
  onClose,
  onCreated
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const [url, setUrl] = useState('')
  if (!open) return null

  const submit = (): void => {
    const trimmed = url.trim()
    if (!trimmed) return
    void addFromUrl(trimmed)
      .then((task) => {
        setUrl('')
        onCreated(task.id)
        onClose()
      })
      .catch((error: unknown) => {
        setUrl(error instanceof Error ? error.message : '添加失败')
      })
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 px-6 pb-6">
      <form
        className="rounded-2xl border border-line-strong bg-raised/95 p-4 shadow-[0_20px_60px_rgb(0_0_0/0.45)] backdrop-blur-sm"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="text-[11px] uppercase tracking-[0.16em] text-mist">添加下载</div>
        <input
          autoFocus
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
          }}
          placeholder="粘贴链接"
          className="mt-3 w-full bg-transparent text-[20px] outline-none placeholder:text-mist"
          spellCheck={false}
        />
        <div className="mt-4 flex items-center justify-between text-[12px] text-mist">
          <span>按回车开始，Esc 取消</span>
          <button
            type="submit"
            data-cuelume-press
            data-cuelume-release
            className="rounded-full bg-copper px-3.5 py-1.5 text-on-accent transition-transform duration-150 active:scale-[0.96]"
            disabled={!url.trim()}
          >
            开始下载
          </button>
        </div>
      </form>
    </div>
  )
}
