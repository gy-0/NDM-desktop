export const COMPLETION_ACTIONS = {
  sleep: { label: '让电脑睡眠', result: '已请求电脑睡眠' },
  quit: { label: '退出 NDM', result: '已请求退出 NDM' },
  shutdown: { label: '关闭电脑', result: '已请求关闭电脑' }
} as const

export type CompletionAction = keyof typeof COMPLETION_ACTIONS
export type CompletionActionReason = 'waitingForTasks' | 'taskMissing' | 'snapshotUnavailable'
export type CompletionActionErrorCode = 'invalidRequest' | 'noPendingTasks' | 'alreadyArmed'
  | 'snapshotUnavailable' | 'actionInProgress' | 'actionFailed' | 'cancelled' | 'shuttingDown'
export type CompletionActionState = {
  oneShot: true
  phase: 'off' | 'armed' | 'countdown' | 'executing' | 'completed' | 'error'
  action?: CompletionAction
  delaySeconds?: number
  armedAt?: number
  countdownEndsAt?: number
  consumedAt?: number
  trackedTaskIDs: number[]
  remainingTaskCount: number
  reason?: CompletionActionReason
  error?: string
}
export type CompletionActionReply = { ok: true; state: CompletionActionState }
  | { ok: false; code: CompletionActionErrorCode; error: string; state: CompletionActionState }

export function isCompletionAction(value: unknown): value is CompletionAction {
  return typeof value === 'string' && Object.hasOwn(COMPLETION_ACTIONS, value)
}

// completionActionStatus: {} -> CompletionActionReply
// completionActionArm: { action: 'sleep' | 'quit' | 'shutdown', delaySeconds: 30..300 }
// completionActionCancel: {} -> CompletionActionReply
// New application processes always begin off. This is an explicitly armed, one-shot action.
