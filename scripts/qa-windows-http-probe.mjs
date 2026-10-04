import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron } from 'playwright'
const root = await mkdtemp(join(tmpdir(), 'ndm-http-probe-'))
const seen = []
const server = createServer((req, res) => {
  seen.push({ url: req.url, authorization: req.headers.authorization, range: req.headers.range })
  if (req.url === '/redirect') { res.writeHead(302, { Location: `http://localhost:${server.address().port}/file` }); res.end(); return }
  res.writeHead(206, { ETag: '"fixture-v1"', 'Content-Range': 'bytes 0-0/8388608', 'Content-Length': 1 }); res.end('A')
})
const proxy = createServer((req, res) => {
  seen.push({ proxy: true, url: req.url, range: req.headers.range })
  res.writeHead(206, { ETag: '"proxy-v1"', 'Content-Range': 'bytes 0-0/1024', 'Content-Length': 1 }); res.end('P')
})
await new Promise(resolve => server.listen(0, resolve))
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
await build({ entryPoints: ['src/main/windows/electronHTTPRepresentation.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(root, 'probe.cjs') })
await writeFile(join(root, 'main.cjs'), `const {app}=require('electron'); app.setPath('userData', ${JSON.stringify(join(root, 'profile'))}); global.probe=require('./probe.cjs').inspectHTTPRepresentation; app.whenReady().then(()=>{});`)
let app
try {
  app = await electron.launch({ args: [join(root, 'main.cjs')], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } })
  const direct = await app.evaluate(async ({app}, url) => { await app.whenReady(); return global.probe(url, ['Authorization: fixture-only']) }, `http://127.0.0.1:${server.address().port}/redirect`)
  assert.equal(direct.etag, '"fixture-v1"'); assert.equal(direct.totalBytes, 8388608)
  assert.equal(seen[0].authorization, 'fixture-only'); assert.equal(seen[1].authorization, undefined)
  const proxied = await app.evaluate(async (_, port) => global.probe('http://unresolvable.example.invalid/file', [], `http://127.0.0.1:${port}`), proxy.address().port)
  assert.equal(proxied.etag, '"proxy-v1"'); assert.ok(seen.some(r => r.proxy))
  console.log(JSON.stringify({ passed: true, scope: 'Real Electron header probe, local HTTP redirect and explicit HTTP proxy; no Windows binary execution', direct, proxied, requests: seen.map(({authorization, ...r})=>({...r, authorizationPresent: Boolean(authorization)})) }, null, 2))
} finally {
  if (app) await app.evaluate(({app})=>app.exit(0)).catch(()=>{})
  server.closeAllConnections(); proxy.closeAllConnections(); await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>proxy.close(r))])
}
