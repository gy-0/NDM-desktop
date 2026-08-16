import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const app = await electron.launch(qaLaunchOptions('duplicate'))
const win = await app.firstWindow()
const issues = []
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text())
})
await win.waitForLoadState('domcontentloaded')
await completeOnboarding(win)
await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, { timeout: 15_000 })
await win.waitForFunction(async () => {
  try {
    const reply = await window.ndm.request('ping')
    return reply?.ok === true
  } catch {
    return false
  }
}, undefined, { timeout: 15_000 })

let existing = null
for (let attempt = 0; attempt < 20 && !existing; attempt += 1) {
  existing = await win.evaluate(async () => {
    try {
      const reply = await window.ndm.request('add', {
        url: 'https://example.com/releases/ndm-duplicate.bin?utm_source=first',
        filename: '已有的下载.bin',
        autoStart: false
      })
      return reply.task
    } catch {
      return null
    }
  })
  if (!existing) await win.waitForTimeout(250)
}
if (!existing) throw new Error('engine never accepted the duplicate fixture')

await win.getByRole('button', { name: /添加下载/ }).click()
const field = win.getByPlaceholder(/粘贴下载链接/)
await field.fill('https://example.com/releases/ndm-duplicate.bin?utm_source=second')
await win.getByText('这项内容已经在下载列表中').waitFor({ timeout: 5_000 })

const duplicateState = {
  filename: await win.getByText(/已有的下载\.bin · /).textContent(),
  primary: await win.getByRole('button', { name: '仍要再下一份' }).textContent(),
  existingAction: await win.getByRole('button', { name: '查看已有' }).isVisible()
}
await win.getByRole('button', { name: '查看已有' }).click()
await win.getByRole('heading', { name: '已有的下载.bin' }).waitFor()

const after = await win.evaluate(async () => {
  const reply = await window.ndm.request('list')
  return reply.tasks
})
if (after.length !== 1 || after[0].id !== existing.id) {
  throw new Error('view existing created or selected the wrong task')
}
writeFileSync('/tmp/ndm-duplicate.png', await win.screenshot())
console.log(JSON.stringify({ duplicateState, taskCount: after.length, selectedTask: after[0].id, issues }))

await win.evaluate(async (taskID) => {
  await window.ndm.request('remove', { taskID, deleteFile: false })
}, existing.id)
await app.close()
