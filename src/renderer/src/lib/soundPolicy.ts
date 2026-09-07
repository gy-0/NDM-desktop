// Removed by user preference everywhere, including declarative bindings.
const REMOVED_CUES = new Set(['page', 'droplet', 'release'])
export function isAudibleCue(name: string): boolean { return !REMOVED_CUES.has(name) }
