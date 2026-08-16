import { _electron as electron } from 'playwright'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'

// A server that serves one partial response then dies completely.
let served = false
const server = createServer((req, res) => {
  served = true
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(20 * 1024 * 1024),
    'Accept-Ranges': 'bytes'
  })
  res.write(Buffer.alloc(128 * 1024))
  setTimeout(() => {
    req.socket.destroy()
    server.close()
  }, 400)
})
await new Promise((r) => server.listen(8124, '127.0.0.1', r))

const app = await electron.launch({ args: ['.'], cwd: '/Users/gaoyuan/NDM-desktop' })
const win = await app.firstWindow()
const errors = []
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await win.waitForSelector('main', { timeout: 15000 })
await win.waitForTimeout(2500)

async function shot(name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const img = await w.capturePage()
    const [cw, ch] = w.getContentSize()
    return img.resize({ width: cw, height: ch, quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(`/tmp/ndm-r2-${name}.png`, Buffer.from(b64, 'base64'))
  console.log(`shot: ${name}`)
}

await shot('1-main')

// Add the doomed download via composer
await win.keyboard.press('Meta+n')
await win.waitForTimeout(500)
const urlInput = win.locator('input[placeholder*="链接"], input[placeholder*="口令"]').first()
await urlInput.fill('http://127.0.0.1:8124/doomed-file.bin')
await win.waitForTimeout(400)
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)

// Poll engine directly for the task's true status
function engineList() {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: 51874 })
    let buf = ''
    s.setEncoding('utf8')
    s.on('connect', () => s.write('{"id":1,"op":"list"}\n'))
    s.on('data', (c) => {
      buf += c
      if (buf.includes('\n')) {
        try { resolve(JSON.parse(buf.split('\n')[0])) } catch { resolve(null) }
        s.end()
      }
    })
    s.on('error', () => resolve(null))
    setTimeout(() => { s.destroy(); resolve(null) }, 5000)
  })
}

let engineStatus = null
let uiStatus = null
for (let i = 0; i < 30; i++) {
  await win.waitForTimeout(3000)
  const reply = await engineList()
  const task = (reply?.tasks ?? []).find((t) => String(t.url).includes('doomed-file'))
  engineStatus = task?.status ?? null
  uiStatus = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-task-state]')]
    const row = rows.find((r) => r.textContent.includes('doomed-file'))
    return row ? row.getAttribute('data-task-state') : null
  })
  console.log(`t+${(i + 1) * 3}s engine=${engineStatus} ui=${uiStatus} served=${served}`)
  if (engineStatus === 'error') break
}

// Give the UI a generous 6 extra seconds to catch up after engine says error
await win.waitForTimeout(6000)
uiStatus = await win.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-task-state]')]
  const row = rows.find((r) => r.textContent.includes('doomed-file'))
  return row ? row.getAttribute('data-task-state') : null
})
const headerText = await win.evaluate(() => document.querySelector('header')?.innerText ?? '')
console.log('FINAL: engine=', engineStatus, '| ui=', uiStatus, '| header=', JSON.stringify(headerText.slice(0, 60)))
console.log('BUG CONFIRMED:', engineStatus === 'error' && uiStatus !== 'error')
await shot('2-after-failure')

// cleanup: remove the test task
const reply = await engineList()
const task = (reply?.tasks ?? []).find((t) => String(t.url).includes('doomed-file'))
if (task) {
  await new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: 51874 }, () => {
      s.write(JSON.stringify({ id: 2, op: 'remove', taskID: task.id, deleteFile: true }) + '\n')
      setTimeout(() => { s.end(); resolve() }, 600)
    })
    s.on('error', () => resolve())
  })
  console.log('cleaned test task', task.id)
}

console.log('console errors:', errors.length ? errors.join(' | ') : 'none')
await app.close()
console.log('DONE')
