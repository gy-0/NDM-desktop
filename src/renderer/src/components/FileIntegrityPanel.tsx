import { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, LoaderCircle, ShieldCheck, Square, X } from 'lucide-react'
import {
  FILE_INTEGRITY_ALGORITHMS, normalizeIntegrityDigest,
  type FileIntegrityAlgorithm, type FileIntegrityJob, type FileIntegrityReply
} from '../../../shared/fileIntegrity'
import { formatBytes } from '../lib/format'
import type { Task } from '../lib/types'

const CONTROL = 'inline-flex h-control items-center justify-center gap-1.5 rounded-control border border-line px-2.5 text-label transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-paper/20 disabled:cursor-not-allowed disabled:opacity-50'

async function request(op: string, extra: Record<string, unknown>): Promise<FileIntegrityJob | null> {
  const reply = await window.ndm?.request(op, extra) as FileIntegrityReply | undefined
  if (!reply || typeof reply.ok !== 'boolean') throw new Error('文件校验服务暂不可用，请稍后重试。')
  if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code })
  return reply.job
}

/** Local, read-only verification of the completed file selected in the inspector. */
export function FileIntegrityPanel({ task }: { task: Task }) {
  const inputID = useId()
  const generation = useRef(0)
  const [algorithm, setAlgorithm] = useState<FileIntegrityAlgorithm>('sha256')
  const [expected, setExpected] = useState('')
  const [job, setJob] = useState<FileIntegrityJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const running = job?.state === 'running'
  const validExpected = !expected.trim() || normalizeIntegrityDigest(algorithm, expected) !== null

  useEffect(() => {
    const current = ++generation.current
    setJob(null)
    setAlgorithm('sha256')
    setExpected('')
    setError(null)
    setSubmitting(false)
    setCancelling(false)
    setCopied(false)
    setLoading(task.status === 'complete')
    if (task.status !== 'complete') return
    void request('fileIntegrityStatus', { taskID: task.id }).then(result => {
      if (generation.current !== current) return
      setJob(result)
      if (result) {
        setAlgorithm(result.algorithm)
        setExpected(result.expectedDigest ?? '')
      }
    }).catch(reason => {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : '暂时无法读取校验记录。')
    }).finally(() => { if (generation.current === current) setLoading(false) })
    return () => { generation.current++ }
  }, [task.id, task.status, task.filename, task.folderPath])

  useEffect(() => {
    if (!job || job.state !== 'running') return
    const id = job.id
    const current = generation.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const result = await request('fileIntegrityStatus', { jobID: id })
        if (stopped || generation.current !== current) return
        setJob(result)
        setError(null)
        if (result?.state === 'running') timer = setTimeout(() => { void poll() }, 300)
      } catch (reason) {
        if (stopped || generation.current !== current) return
        setError(reason instanceof Error ? reason.message : '暂时无法读取校验进度。')
        if (reason && typeof reason === 'object' && 'code' in reason
          && (reason.code === 'jobNotFound' || reason.code === 'shuttingDown')) {
          setJob(null)
          return
        }
        timer = setTimeout(() => { void poll() }, 1200)
      }
    }
    timer = setTimeout(() => { void poll() }, 150)
    return () => { stopped = true; clearTimeout(timer) }
  }, [job?.id, job?.state])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])

  const start = async (): Promise<void> => {
    if (loading || submitting || running || !validExpected) return
    const current = generation.current
    setSubmitting(true)
    setCopied(false)
    setError(null)
    try {
      const result = await request('fileIntegrityStart', { taskID: task.id, algorithm,
        ...(expected.trim() ? { expectedDigest: expected.trim() } : {}) })
      if (generation.current === current) setJob(result)
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : '未能开始文件校验。')
    } finally { if (generation.current === current) setSubmitting(false) }
  }
  const cancel = async (): Promise<void> => {
    if (!job || cancelling) return
    const current = generation.current
    setCancelling(true)
    try {
      const result = await request('fileIntegrityCancel', { jobID: job.id })
      if (generation.current === current) { setJob(result); setError(null) }
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : '暂时无法取消校验。')
    } finally { if (generation.current === current) setCancelling(false) }
  }

  if (task.status !== 'complete') return null
  const percent = job?.totalBytes ? Math.min(100, Math.floor(job.completedBytes / job.totalBytes * 100)) : 0
  const inputDisabled = loading || submitting || running
  const resultApplies = job?.algorithm === algorithm && (job.expectedDigest ?? '') === (expected.trim() ? normalizeIntegrityDigest(algorithm, expected) : '')
  const resultLabel = job?.matches === true ? '校验一致' : job?.matches === false ? '校验值不一致' : '计算完成'

  return <section className="border-t border-line pt-4" aria-label="文件校验" data-file-integrity-panel>
    <div className="mb-3 flex items-center gap-2 text-body font-medium text-paper"><ShieldCheck size={14} />文件校验</div>
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="校验算法">
      {(Object.keys(FILE_INTEGRITY_ALGORITHMS) as FileIntegrityAlgorithm[]).map(value => <button
        key={value} type="button" className={`${CONTROL} ${algorithm === value ? 'border-line-strong bg-raised text-paper' : 'text-mist'}`}
        aria-pressed={algorithm === value} disabled={inputDisabled} onClick={() => setAlgorithm(value)}
      >{FILE_INTEGRITY_ALGORITHMS[value].label}</button>)}
    </div>
    <label htmlFor={inputID} className="mb-1.5 mt-3 block text-label text-mist">期望校验值（可选）</label>
    <input id={inputID} value={expected} disabled={inputDisabled} maxLength={128}
      onChange={event => setExpected(event.target.value)} placeholder={`${FILE_INTEGRITY_ALGORITHMS[algorithm].hexLength} 位十六进制值`}
      aria-invalid={!validExpected} aria-describedby={!validExpected ? `${inputID}-error` : undefined}
      autoComplete="off" spellCheck={false}
      className="w-full rounded-control border border-line bg-raised px-2.5 py-2 font-mono text-caption text-paper outline-none placeholder:text-mist/60 focus:border-line-strong disabled:opacity-50" />
    {!validExpected && <p id={`${inputID}-error`} className="mt-1.5 text-label text-clay">请输入 {FILE_INTEGRITY_ALGORITHMS[algorithm].hexLength} 位十六进制校验值。</p>}
    <div className="mt-3 flex items-center gap-2">
      {running ? <button type="button" className={`${CONTROL} text-mist`} disabled={cancelling} onClick={() => { void cancel() }}>
        <Square size={12} />{cancelling ? '正在取消…' : '取消校验'}
      </button> : <button type="button" className={`${CONTROL} text-paper`} disabled={inputDisabled || !validExpected} onClick={() => { void start() }}>
        {(loading || submitting) && <LoaderCircle size={12} className="animate-spin" />}
        {loading ? '读取记录…' : submitting ? '正在开始…' : expected.trim() ? '校验文件' : '计算校验值'}
      </button>}
      {running && <span className="text-label tabular-nums text-mist">{formatBytes(job.completedBytes)} / {formatBytes(job.totalBytes)}</span>}
    </div>
    {running && <div className="mt-2 h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label="文件校验进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="h-full origin-left bg-copper transition-transform duration-200" style={{ transform: `scaleX(${percent / 100})` }} />
    </div>}
    <div aria-live="polite" className="mt-3">
      {job?.state === 'complete' && job.digest && resultApplies && <div>
        <div className={`flex items-center justify-between gap-2 text-label ${job.matches === false ? 'text-clay' : 'text-sage'}`}>
          <span className="inline-flex items-center gap-1.5">{job.matches === false ? <X size={13} /> : <Check size={13} />}{resultLabel} · {FILE_INTEGRITY_ALGORITHMS[job.algorithm].label}</span>
          <button type="button" className="inline-flex items-center gap-1 text-mist hover:text-paper" aria-label="复制校验值" onClick={() => {
            const digest = job.digest!
            const current = generation.current
            void navigator.clipboard.writeText(digest).then(() => { if (generation.current === current) setCopied(true) })
              .catch(() => { if (generation.current === current) setError('未能复制校验值，请选中下方文字复制。') })
          }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? '已复制' : '复制'}</button>
        </div>
        <code className="mt-2 block select-text break-all rounded-control bg-raised px-2.5 py-2 font-mono text-caption leading-relaxed text-fog">{job.digest}</code>
        {job.matches === false && <p className="mt-1.5 text-label text-mist">请核对所选算法与来源提供的校验值。</p>}
        <p className="mt-1.5 text-caption text-mist">计算于 {new Date(job.updatedAt).toLocaleString()}</p>
      </div>}
      {job?.state === 'cancelled' && <p className="text-label text-mist">已取消校验。</p>}
      {job?.state === 'error' && <p className="text-label text-clay">{job.error}</p>}
      {error && <p role="alert" className="mt-1.5 text-label text-clay">{error}</p>}
    </div>
  </section>
}
