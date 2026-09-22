// Built React UI with a narrow HTTP adapter to an isolated QA Host.
// This serves fixtures only; it does not drive the browser or use a real profile.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

export async function startRendererHostFixture(rpc) {
  const root = resolve('out/renderer')
  const source = await readFile('scripts/qa-workspace.mjs', 'utf8')
  const begin = source.indexOf('await page.addInitScript(() => {') + 'await page.addInitScript('.length
  const end = source.indexOf('\n})\n\nconst search', begin) + 3
  if (begin < 30 || end < begin) throw new Error('QA preload fixture boundaries changed')
  const initial = source.slice(begin, end - 1)
  const allowed = ['list', 'getSettings', 'pause', 'resume', 'redownloadChangedResource']
  const injected = `(${initial})();const fixtureRequest=window.ndm.request;window.ndm.request=async(op,extra={})=>${JSON.stringify(allowed)}.includes(op)?fetch('/qa-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,extra})}).then(r=>r.json()):fixtureRequest(op,extra);window.ndm.onEvent=callback=>{const timer=setInterval(()=>window.ndm.request('list').then(reply=>callback({op:'snapshot',tasks:reply.tasks})).catch(()=>{}),500);return()=>clearInterval(timer)};`
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' }
  const calls = []
  const server = createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`
      const url = new URL(req.url, origin)
      if (url.pathname === '/qa-rpc') {
        if (req.method !== 'POST' || req.headers.origin !== origin) throw new Error('Fixture origin mismatch')
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Fixture request too large') }
        const { op, extra } = JSON.parse(body)
        if (!allowed.includes(op)) throw new Error('Unsupported fixture operation')
        calls.push(op)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(await rpc(op, extra)))
        return
      }
      const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)))
      if (!file.startsWith(root + sep)) throw new Error('Outside fixture assets')
      let body = await readFile(file)
      if (file.endsWith('/index.html')) body = body.toString().replace('<head>', `<head><script>${injected}</script>`)
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body)
    } catch { res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"QA fixture request failed"}') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${server.address().port}/`, calls,
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)) } }
}
