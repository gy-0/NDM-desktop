import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { qaLaunchOptions } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('media-delivery'))
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, {
  timeout: 15_000
})
await win.waitForTimeout(1_500)

const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const folderPath = `/tmp/ndm-media-delivery-${process.pid}`
mkdirSync(folderPath, { recursive: true })
const result = await win.evaluate(async ({ url, folderPath }) => {
  const probe = await window.ndm.request('probeMedia', { url })
  const format = probe.formats?.at(-1)
  if (!format) throw new Error('media probe returned no formats')
  const subtitleLanguage = probe.subtitles?.[0]?.code
  const added = await window.ndm.request('addMedia', {
    url,
    folderPath,
    filename: 'NDM Media Delivery QA',
    formatID: format.id,
    container: 'compactMKV',
    subtitleLanguage,
    collectionScope: 'current'
  })
  return { probe, added, subtitleLanguage }
}, { url, folderPath })

const task = result.added.task
if (!task.filename.endsWith('.mkv')) throw new Error(`wrong container filename: ${task.filename}`)
if (task.mediaOptions?.container !== 'compactMKV') throw new Error(`missing media options: ${JSON.stringify(task)}`)
if (task.mediaOptions?.subtitleLanguage !== result.subtitleLanguage) {
  throw new Error(`subtitle choice was not persisted: ${JSON.stringify(task.mediaOptions)}`)
}
if (!task.thumbnailURL || task.pageURL !== url) throw new Error('media provenance was not persisted')

await win.evaluate(async (taskID) => {
  await window.ndm.request('pause', { taskID })
  await window.ndm.request('remove', { taskID, deleteFile: true })
}, task.id)

console.log(JSON.stringify({
  formatCount: result.probe.formats.length,
  subtitleCount: result.probe.subtitles.length,
  task: {
    id: task.id,
    filename: task.filename,
    pageURL: task.pageURL,
    hasThumbnail: Boolean(task.thumbnailURL),
    mediaOptions: task.mediaOptions
  }
}))
await app.close()
