import type { MediaProbeResult } from './types'

export function mediaAccessMessage(kind: MediaProbeResult['errorKind']): string | null {
  if (kind === 'regionRestricted') return '来源网站限制了该内容的可访问地区。请在来源页面确认可用范围。'
  if (kind === 'entitlementRequired') return '此内容需要会员或特定账号的访问权限。请先在来源页面确认访问条件；如果浏览器中可以播放，可自行选择使用浏览器会话重试。'
  return null
}

/** Explicit access denial must never fall back to downloading the HTML page. */
export class MediaAccessFailure extends Error {
  constructor(kind: MediaProbeResult['errorKind']) {
    super(mediaAccessMessage(kind) ?? '来源网站暂未允许访问此内容。')
    this.name = 'MediaAccessFailure'
  }
}
