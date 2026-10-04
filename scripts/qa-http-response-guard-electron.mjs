// Isolated Chromium/proxy transport QA, no installed app or user profile access.
import { app } from 'electron'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { HTTPResponseGuard } from '../src/main/windows/httpResponseGuard.ts'
import { inspectHTTPRepresentation, openHTTPResponse } from '../src/main/windows/electronHTTPRepresentation.ts'
async function main() {
await app.whenReady()
const root = app.commandLine.getSwitchValue('user-data-dir')
assert.ok(root && root.includes('ndm-guard-electron-'))
let version = 1
const requests = []
const proxy = createServer((request, response) => {
  requests.push({url:request.url, range:request.headers.range, cookie:request.headers.cookie, authorization:request.headers.authorization})
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
  report.passed=true
} catch(error) {report.error=String(error);process.exitCode=1}
finally {
  guard.close();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve))
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
  app.exit(report.passed?0:1)
}

}
void main().catch(error => { console.error(error); app.exit(1) })
