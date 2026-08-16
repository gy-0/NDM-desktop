import { useSyncExternalStore } from 'react'

/**
 * Local entitlement record. This is a convenience cache of "this Mac has been
 * activated", not a security boundary — real Ed25519 signature verification and
 * store receipt validation are wired later alongside checkout.
 */

export type LicenseTier = 'free' | 'pro'

export interface LicenseRecord {
  tier: 'pro'
  key: string
  email: string
  activatedAt: number
}

export type ProFeatureId = 'playlist' | 'ultraHD' | 'cloudHistory' | 'convert'

export interface ProFeature {
  id: ProFeatureId
  name: string
  note: string
}

/** The single source of truth for what Pro unlocks. Gate from here, never inline. */
export const PRO_FEATURES: readonly ProFeature[] = [
  { id: 'playlist', name: '播放列表与频道整批下载', note: '一次排入整个合集，不限条数' },
  { id: 'ultraHD', name: '4K / 8K 超清与高码率轨', note: '解锁 2160p 以上的视频与音频轨' },
  { id: 'cloudHistory', name: '下载历史云同步', note: '多台 Mac 之间保持同一份记录' },
  { id: 'convert', name: '格式转换与音频提取', note: '下载后直接转码或抽出音轨' }
]

export const PRO_PRICING = {
  currency: 'USD',
  /** 主推价：一次性买断，个人授权 ≤3 台 Mac。 */
  regular: 24.99,
  /** 早鸟价：早期用户永久有效。 */
  earlyBird: 14.99,
  seats: 3
} as const

/** 免费档：日常够用，且永远不加广告或弹窗。 */
export const FREE_FEATURES: readonly string[] = [
  '多线程分段加速与断点续传',
  'NDM Relay 浏览器接管',
  '单个网页视频与文件下载',
  '分类保存、限速与队列',
  '无广告、无弹窗、无订阅'
]

const LICENSE_STORAGE_KEY = 'ndm.license'
const ONBOARDED_STORAGE_KEY = 'ndm.onboarded'

/** 形如 NDM-7QF2-K3XM-9ATD：仅校验格式，不做签名校验。 */
export const LICENSE_KEY_PATTERN = /^NDM-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/
export const LICENSE_KEY_PLACEHOLDER = 'NDM-XXXX-XXXX-XXXX'

const listeners = new Set<() => void>()
let cached: LicenseRecord | null = null
let hydrated = false

function emit(): void {
  for (const listener of listeners) listener()
}

function parse(raw: string | null): LicenseRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<LicenseRecord> | null
    if (!value || value.tier !== 'pro') return null
    const key = typeof value.key === 'string' ? value.key : ''
    if (!LICENSE_KEY_PATTERN.test(key)) return null
    return {
      tier: 'pro',
      key,
      email: typeof value.email === 'string' ? value.email : '',
      activatedAt: Number.isFinite(value.activatedAt) ? Number(value.activatedAt) : Date.now()
    }
  } catch {
    return null
  }
}

export function getLicense(): LicenseRecord | null {
  if (!hydrated) {
    try {
      cached = parse(localStorage.getItem(LICENSE_STORAGE_KEY))
    } catch {
      cached = null
    }
    hydrated = true
  }
  return cached
}

export function setLicense(record: LicenseRecord): void {
  cached = record
  hydrated = true
  try {
    localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // The current window still reflects the change even without storage.
  }
  emit()
}

export function clearLicense(): void {
  cached = null
  hydrated = true
  try {
    localStorage.removeItem(LICENSE_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  emit()
}

export function isPro(): boolean {
  return getLicense() !== null
}

/**
 * The one gate every Pro-only control goes through. A capability is gated when
 * it is listed in PRO_FEATURES and this Mac has no entitlement.
 */
export function requiresPro(feature: ProFeatureId): boolean {
  if (isPro()) return false
  return PRO_FEATURES.some((item) => item.id === feature)
}

export function normalizeLicenseKey(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z-]/g, '').slice(0, 19)
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

export type RedeemResult =
  | { ok: true; record: LicenseRecord }
  | { ok: false; field: 'email' | 'key'; error: string }

/**
 * Format-validate and store the entitlement locally. No network call: checkout
 * and signed-key verification arrive with the store wiring.
 */
export function redeem(key: string, email: string): RedeemResult {
  const trimmedEmail = email.trim()
  if (!looksLikeEmail(trimmedEmail)) {
    return { ok: false, field: 'email', error: '请填写购买时使用的邮箱地址' }
  }
  const normalized = normalizeLicenseKey(key.trim())
  if (!LICENSE_KEY_PATTERN.test(normalized)) {
    return { ok: false, field: 'key', error: `激活码格式应为 ${LICENSE_KEY_PLACEHOLDER}` }
  }
  const record: LicenseRecord = {
    tier: 'pro',
    key: normalized,
    email: trimmedEmail,
    activatedAt: Date.now()
  }
  setLicense(record)
  return { ok: true, record }
}

export function formatActivatedAt(ms: number): string {
  return new Date(ms).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useLicense(): LicenseRecord | null {
  return useSyncExternalStore(subscribe, getLicense, getLicense)
}

export function useIsPro(): boolean {
  return useLicense() !== null
}

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_STORAGE_KEY) === '1'
  } catch {
    return true
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_STORAGE_KEY, '1')
  } catch {
    /* ignore */
  }
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDED_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
