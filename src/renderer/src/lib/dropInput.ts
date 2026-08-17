import { extractSharedLinks, type SharedLinkResolution } from './sharedLink'

export type DroppedInputResolution =
  | { accepted: true; link: SharedLinkResolution }
  | { accepted: false; reason: 'localFile' | 'unsupported' }

export function resolveDroppedInput({
  uriList,
  plainText,
  hasFiles
}: {
  uriList: string
  plainText: string
  hasFiles: boolean
}): DroppedInputResolution {
  if (hasFiles) return { accepted: false, reason: 'localFile' }

  const input = [uriList, plainText]
    .filter(Boolean)
    .join('\n')
    .trim()
  if (!input) return { accepted: false, reason: 'unsupported' }

  const link = extractSharedLinks(input)[0]
  if (link) return { accepted: true, link }
  if (/^\s*file:/im.test(input)) return { accepted: false, reason: 'localFile' }
  return { accepted: false, reason: 'unsupported' }
}

export function dragCarriesDownloadLink(types: readonly string[]): boolean {
  if (types.includes('Files')) return false
  return types.includes('text/uri-list') || types.includes('text/plain')
}
