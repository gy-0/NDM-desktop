import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'

// Isolated engine/data; only select rows and resize the inspector.
const app = await electron.launch(qaLaunchOptions('inspector-selection', { seedHistory: true }))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await win.waitForSelector('[data-task-select]')
  await win.locator('[data-task-select]').first().click()
  await win.waitForTimeout(250)
  await win.getByRole('separator', { name: '调整任务详情宽度' }).focus()
  const beforeResize = await win.locator('#task-inspector').evaluate(pane => pane.style.width)
  await win.keyboard.press('ArrowLeft')
  await win.waitForFunction(previous => document.querySelector('#task-inspector')?.style.width !== previous, beforeResize)
  const result = await win.evaluate(async () => {
    const pane = document.querySelector('#task-inspector')
    const width = pane.getBoundingClientRect().width
    const preferredWidth = pane.style.width
    const ids = [...document.querySelectorAll('[data-task-select]')].slice(1, 6).map(row => row.dataset.taskSelect)
    const samples = []
    let sampling = true
    const sample = () => {
      const current = document.querySelector('#task-inspector')
      samples.push({ sameNode: current === pane, width: current?.getBoundingClientRect().width, preferredWidth: current?.style.width })
      if (sampling) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    for (const id of ids) {
      document.querySelector('[data-task-select="' + id + '"]').click()
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    sampling = false
    return { width, preferredWidth, selections: ids.length, samples }
  })
  console.log(JSON.stringify({ baseline: result.width, widths: [...new Set(result.samples.map(s => s.width))], nodesStable: result.samples.every(s => s.sameNode) }))
  assert.equal(result.selections, 5)
  assert.ok(result.samples.length > 20, 'observe animation frames during selection')
  assert.ok(result.samples.every(sample => sample.sameNode), 'outer pane must survive selection changes')
  assert.ok(result.samples.every(sample => Math.abs(sample.width - result.width) < 0.1), 'pane width must remain stable on every frame')
  assert.ok(result.samples.every(sample => sample.preferredWidth === result.preferredWidth), 'user width must survive selection changes')
  console.log(JSON.stringify({ selections: result.selections, frames: result.samples.length, width: result.width, preferredWidth: result.preferredWidth, stable: true }))
} finally {
  await app.close()
}
