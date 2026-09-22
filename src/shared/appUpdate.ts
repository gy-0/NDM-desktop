export type AppUpdateReply =
  | { status: 'unpublished'; checkedAt: number }
  | { status: 'release'; checkedAt: number; version: string; relation: 'newer' | 'current' | 'older' | 'unknown'; url: string }
  | { status: 'error'; reason: 'network' | 'rateLimit' | 'invalid' }
