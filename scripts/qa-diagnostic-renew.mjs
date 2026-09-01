import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { qaLaunchOptions } from './qa-env.mjs'

const server = createServer((_request, response) => {
  response.writeHead(403, { 'content-type': 'text/plain' })
  response.end('expired')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0

const app = await electron.launch(qaLaunchOptions('diagnostic-renew'))
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => window.ndm?.status().then((status) => status === 'live'), undefined, {
  timeout: 15_000
})
await win.waitForTimeout(1_500)

const created = await win.evaluate(async (url) => {
  const reply = await window.ndm.request('add', {
    url,
    filename: 'expired-qa.bin',
    pageURL: 'https://example.com/source',
    autoStart: true
  })
  return reply.task
}, `http://127.0.0.1:${port}/expired.bin`)

let failed
for (let attempt = 0; attempt < 48; attempt += 1) {
  failed = await win.evaluate(async (taskID) => {
    const reply = await window.ndm.request('list')
    return reply.tasks.find((task) => task.id === taskID)
  }, created.id)
  if (failed?.status === 'error' && failed.diagnostic) break
  await win.waitForTimeout(250)
}
const renewed = await win.evaluate(async ({ taskID, url }) => {
  const reply = await window.ndm.request('renew', { taskID, url, autoStart: false })
  return reply.task
}, { taskID: created.id, url: `http://127.0.0.1:${port}/fresh` })

if (!failed.diagnostic || failed.diagnostic.primaryAction !== 'renew' || !/(过期|失效)/.test(failed.diagnostic.title)) {
  throw new Error(`unexpected diagnostic: ${JSON.stringify(failed)}`)
}
if (renewed.id !== created.id || renewed.url !== `http://127.0.0.1:${port}/fresh` || renewed.errorText) {
  throw new Error(`renew did not preserve task identity: ${JSON.stringify(renewed)}`)
}

console.log(JSON.stringify({
  failed: { id: failed.id, status: failed.status, diagnostic: failed.diagnostic },
  renewed: { id: renewed.id, status: renewed.status, url: renewed.url }
}))
await app.close()
await new Promise((resolve) => server.close(resolve))
