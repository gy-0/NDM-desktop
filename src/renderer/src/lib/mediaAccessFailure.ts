import type { MediaProbeResult } from './types'

export function mediaAccessMessage(kind: MediaProbeResult['errorKind']): string | null {
  if (kind === 'regionRestricted') return '该内容受地区限制，请查看来源网站的访问要求。'
  if (kind === 'entitlementRequired') return '该内容需要访问权限。请在来源网站确认账号权限后重试。'
  return null
}

/** Explicit access denial must never fall back to downloading the HTML page. */
export class MediaAccessFailure extends Error {
  constructor(kind: MediaProbeResult['errorKind']) {
    super(mediaAccessMessage(kind) ?? '来源网站暂未允许访问此内容。')
    this.name = 'MediaAccessFailure'
  }
}
