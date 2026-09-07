/** Only explicit structured metadata can qualify the offered formats as preview. */
export function mediaAvailabilityNotice(value: unknown): 'previewOnly' | undefined {
  return value === 'previewOnly' ? 'previewOnly' : undefined
}
