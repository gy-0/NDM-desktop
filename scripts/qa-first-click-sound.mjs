import { _electron as electron } from 'playwright'
import { qaLaunchOptions } from './qa-env.mjs'

const options = qaLaunchOptions('first-click-sound')
const app = await electron.launch(options)

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(() => {
    localStorage.setItem('ndm.onboarded', '1')
    localStorage.setItem('ndm-sound', '1')
  })

  await win.addInitScript(() => {
    const trace = []
    Object.defineProperty(window, '__ndmSoundTrace', { value: trace, configurable: true })

    const record = (event) => {
      trace.push({
        event,
        at: performance.now(),
        active: navigator.userActivation?.isActive ?? null,
        sticky: navigator.userActivation?.hasBeenActive ?? null
      })
    }

    document.addEventListener('pointerdown', () => record('pointerdown'), true)

    const OriginalAudioContext = window.AudioContext || window.webkitAudioContext
    if (OriginalAudioContext) {
      const TracedAudioContext = new Proxy(OriginalAudioContext, {
        construct(target, args) {
          const context = Reflect.construct(target, args)
          record('audio-context-created')
          return context
        }
      })
      Object.defineProperty(window, 'AudioContext', { value: TracedAudioContext, configurable: true })
      if (window.webkitAudioContext) {
        Object.defineProperty(window, 'webkitAudioContext', { value: TracedAudioContext, configurable: true })
      }
    }

    for (const prototype of [window.OscillatorNode?.prototype, window.AudioBufferSourceNode?.prototype]) {
      if (!prototype?.start) continue
      const start = prototype.start
      prototype.start = function (...args) {
        record('sound-source-start')
        return start.apply(this, args)
      }
    }
  })

  await win.reload({ waitUntil: 'domcontentloaded' })
  const sidebarButtons = win.locator('nav button')
  await sidebarButtons.first().waitFor({ state: 'visible' })
  await win.waitForTimeout(250)

  const beforeClick = await win.evaluate(() => [...window.__ndmSoundTrace])
  if (beforeClick.some((entry) => entry.event === 'pointerdown')) {
    throw new Error(`sound warm-up unexpectedly required a pointer click: ${JSON.stringify(beforeClick)}`)
  }

  await sidebarButtons.nth(1).click()
  await win.waitForTimeout(120)
  const afterClick = await win.evaluate(() => [...window.__ndmSoundTrace])
  const pointerIndex = afterClick.findIndex((entry) => entry.event === 'pointerdown')
  const sourceAfterPointer = afterClick.slice(pointerIndex + 1).find((entry) => entry.event === 'sound-source-start')
  if (pointerIndex < 0 || !sourceAfterPointer) {
    throw new Error(`first sidebar click did not start its press sound: ${JSON.stringify(afterClick)}`)
  }

  const prewarmed = beforeClick.some((entry) => entry.event === 'audio-context-created')
  const sourcesAfterPointer = afterClick.slice(pointerIndex + 1).filter((entry) => entry.event === 'sound-source-start')
  if (!prewarmed && sourcesAfterPointer.length < 2) {
    throw new Error(`cold first click was not replayed after priming: ${JSON.stringify(afterClick)}`)
  }

  const replayGapMs = sourcesAfterPointer.length > 1
    ? sourcesAfterPointer.at(-1).at - sourcesAfterPointer[0].at
    : 0
  if (!prewarmed && (replayGapMs < 20 || replayGapMs > 100)) {
    throw new Error(`cold first-click replay timing was invalid (${replayGapMs.toFixed(1)} ms)`)
  }

  console.log(JSON.stringify({ prewarmed, replayGapMs, trace: afterClick }, null, 2))
  console.log('DONE')
} finally {
  await app.close()
}
