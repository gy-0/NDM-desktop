import { _electron as electron } from 'playwright'
import { qaLaunchOptions } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('storage-confidence'))
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, {
  timeout: 15_000
})
await win.waitForTimeout(1_500)

const result = await win.evaluate(async () => {
  const comfortable = await window.ndm.request('checkStorage', {
    folderPath: '/tmp',
    finalBytes: 1_000_000,
    componentBytes: [600_000, 400_000]
  })
  const insufficient = await window.ndm.request('checkStorage', {
    folderPath: '/tmp',
    finalBytes: 8_000_000_000_000_000,
    componentBytes: [4_000_000_000_000_000, 4_000_000_000_000_000]
  })
  return { comfortable, insufficient }
})

if (result.comfortable.level !== 'comfortable' || result.comfortable.peakBytes !== 2_000_000) {
  throw new Error(`wrong comfortable budget: ${JSON.stringify(result.comfortable)}`)
}
if (result.insufficient.level !== 'insufficient' || result.insufficient.shortfallBytes <= 0) {
  throw new Error(`wrong insufficient budget: ${JSON.stringify(result.insufficient)}`)
}
console.log(JSON.stringify(result))
await app.close()
