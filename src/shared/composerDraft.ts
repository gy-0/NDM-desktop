/** One reviewable batch. Input stays separate until the user adds it to items. */
export type ComposerDraftRequest = {
  op: 'add' | 'addMedia'
  options: {
    url: string
    creationKey: string
    folderPath?: string
    connections?: number
    filename?: string
    autoStart?: boolean
    /** Browser name only; restored requests must acquire a fresh session. */
    cookieBrowser?: string
    /** Random Relay ID only; credentials are refreshed by the original profile. */
    browserSessionID?: string
    formatID?: string
    container?: string
    collectionScope?: 'current'
    pageTitle?: string
    thumbnailURL?: string
    subtitleLanguage?: string
  }
}

export type ComposerDraftItem = {
  id: string
  url: string
  /** Only failed items with an authoritative non-creation result are retryable. */
  status: 'pending' | 'unconfirmed' | 'failed' | 'accepted'
  operationID?: string
  /** Main-process fingerprint; receipt engines calculate their own intent digest. */
  requestDigest?: string
  request?: ComposerDraftRequest
  taskID?: number
}

export type ComposerDraft = {
  version: 1
  id: string
  input: string
  items: ComposerDraftItem[]
  destination: { mode: 'inherit' } | { mode: 'explicit'; path: string }
  connections: { mode: 'inherit' } | { mode: 'explicit'; value: number }
}

export type ComposerDraftSnapshot = {
  ok: true
  revision: number
  draft: ComposerDraft | null
}

export type ComposerDraftErrorCode = 'encryptionUnavailable' | 'encryptionFailed' | 'decryptionFailed'
  | 'readFailed' | 'writeFailed' | 'corrupt' | 'unsupportedVersion' | 'invalid' | 'conflict' | 'shuttingDown'

export type ComposerDraftReply = ComposerDraftSnapshot | {
  ok: false
  code: ComposerDraftErrorCode
  error: string
  /** Omitted when the saved revision cannot be safely read. */
  revision?: number
}

export type ComposerDraftSaveRequest = { expectedRevision: number; draft: ComposerDraft }
export type ComposerDraftDiscardRequest = { expectedRevision: number }

// window.ndm.request('composerDraftLoad') -> ComposerDraftReply
// window.ndm.request('composerDraftSave', ComposerDraftSaveRequest) -> ComposerDraftReply
// window.ndm.request('composerDraftDiscard', ComposerDraftDiscardRequest) -> ComposerDraftReply
// Save/discard ACK only after encrypted atomic commit. Retain local edits on failure.
