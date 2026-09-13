export const FILE_INTEGRITY_ALGORITHMS = {
  sha256: { label: 'SHA-256', hexLength: 64 },
  sha1: { label: 'SHA-1', hexLength: 40 },
  md5: { label: 'MD5', hexLength: 32 }
} as const

export type FileIntegrityAlgorithm = keyof typeof FILE_INTEGRITY_ALGORITHMS
export type FileIntegrityErrorCode = 'invalidRequest' | 'invalidExpectedDigest' | 'taskUnavailable'
  | 'notCompleted' | 'busy' | 'jobNotFound' | 'fileMissing' | 'notRegularFile'
  | 'fileChanged' | 'readFailed' | 'shuttingDown'

export type FileIntegrityJob = {
  id: string
  taskID: number
  filename: string
  algorithm: FileIntegrityAlgorithm
  state: 'running' | 'complete' | 'cancelled' | 'error'
  completedBytes: number
  totalBytes: number
  createdAt: number
  updatedAt: number
  digest?: string
  expectedDigest?: string
  matches?: boolean
  code?: FileIntegrityErrorCode
  error?: string
}

export type FileIntegrityReply = { ok: true; job: FileIntegrityJob | null }
  | { ok: false; code: FileIntegrityErrorCode; error: string }

export function isFileIntegrityAlgorithm(value: unknown): value is FileIntegrityAlgorithm {
  return typeof value === 'string' && Object.hasOwn(FILE_INTEGRITY_ALGORITHMS, value)
}

/** Accept only a plain hexadecimal digest; preserve no copied filenames or labels. */
export function normalizeIntegrityDigest(algorithm: FileIntegrityAlgorithm, value: string): string | null {
  const digest = value.trim()
  return new RegExp(`^[a-f0-9]{${FILE_INTEGRITY_ALGORITHMS[algorithm].hexLength}}$`, 'i').test(digest)
    ? digest.toLowerCase() : null
}

// window.ndm.request('fileIntegrityStart', { taskID, algorithm, expectedDigest? })
// window.ndm.request('fileIntegrityStatus', { jobID }) or { taskID } for its latest job
// window.ndm.request('fileIntegrityCancel', { jobID })
// Every operation returns FileIntegrityReply. The renderer never supplies a file path.
