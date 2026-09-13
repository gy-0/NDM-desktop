import { accessSync, constants } from 'node:fs'

for (const name of ['yt-dlp', 'ffmpeg', 'deno', 'aria2-next', '_internal', 'Licenses', 'Sources', 'aria2-next-manifest.json']) {
  try {
    accessSync(new URL(`../native/Vendor/Tools/${name}`, import.meta.url),
      ['_internal', 'Licenses', 'Sources', 'aria2-next-manifest.json'].includes(name) ? constants.R_OK : constants.X_OK)
  } catch {
    throw new Error(`Missing macOS media tool ${name}. Run npm run fetch:mac-tools before packaging.`)
  }
}
