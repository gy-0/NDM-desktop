// Isolated Chromium/proxy transport QA, no installed app or user profile access.
import { app } from 'electron'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { SingleSubmissionHTTPRelay } from '../src/main/windows/singleSubmissionHTTPRelay.ts'
import { HTTPResponseGuard } from '../src/main/windows/httpResponseGuard.ts'
import { inspectHTTPRepresentation, openHTTPResponse } from '../src/main/windows/electronHTTPRepresentation.ts'
async function main() {
await app.whenReady()
const root = app.commandLine.getSwitchValue('user-data-dir')
assert.ok(root && root.includes('ndm-guard-electron-'))
let version = 1
const requests = []
const proxy = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  requests.push({url:request.url, method:request.method, body:Buffer.concat(chunks).toString('hex'), range:request.headers.range, cookie:request.headers.cookie, authorization:request.headers.authorization})
  if (request.url.endsWith('/export')) {
    response.writeHead(200, { 'content-length': 4 }); response.end('post'); return
  }
  const range = request.headers.range
  const body = Buffer.from(version === 1 ? 'abcd' : 'wxyz')
  response.writeHead(range ? 206 : 200, {etag:`"v${version}"`,'content-length':range ? 1 : 4,...(range ? {'content-range':'bytes 0-0/4'} : {})})
  response.end(range ? body.subarray(0,1) : body)
})
await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve))
const proxyURL = `http://127.0.0.1:${proxy.address().port}`
const url = 'http://ndm-fixture.invalid/file'
const guard = new HTTPResponseGuard(async (...args) => { const response = await openHTTPResponse(...args); report.upstream = {url:response.url,status:response.status,headers:Object.fromEntries(response.headers)}; return response })
const report = {passed:false,requests}
const submission = new SingleSubmissionHTTPRelay(openHTTPResponse)
try {
  const identity = await inspectHTTPRepresentation(url,[],proxyURL)
  assert.ok(identity)
  const route = await guard.register(url,['Cookie: synthetic=1','Authorization: Bearer synthetic'],identity,proxyURL)
  const good = await fetch(route.url)
  const goodBody = await good.text()
  report.good = {status:good.status,body:goodBody,failure:route.failure()?.message}
  assert.equal(goodBody,'abcd')
  version = 2
  const bad = await fetch(route.url)
  assert.equal(bad.status,412)
  assert.equal((await bad.arrayBuffer()).byteLength,0)
  assert.ok(route.failure())
  assert.ok(requests.some(row=>row.cookie==='synthetic=1' && row.authorization==='Bearer synthetic'))
  const binaryBody = new Uint8Array([0,255,61,38]).buffer
  const postRoute = await submission.register('http://ndm-fixture.invalid/export', ['Cookie: synthetic=post','Content-Type: application/octet-stream'], binaryBody, proxyURL)
  assert.equal(await (await fetch(postRoute.url)).text(), 'post')
  assert.equal((await fetch(postRoute.url)).status, 410)
  const posts = requests.filter(row => row.url.endsWith('/export'))
  assert.equal(posts.length, 1); assert.equal(posts[0].method, 'POST'); assert.equal(posts[0].body, '00ff3d26')
  assert.equal(posts[0].cookie, 'synthetic=post'); assert.equal(posts[0].range, undefined)
  report.singleSubmission = true
  report.passed=true
} catch(error) {report.error=String(error);process.exitCode=1}
finally {
  submission.close();guard.close();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve))
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
  app.exit(report.passed?0:1)
}

}
void main().catch(error => { console.error(error); app.exit(1) })
