// Actual Windows orchestration + isolated local aria2; can run on macOS, not Windows OS proof.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
const root = await mkdtemp(join(tmpdir(), 'ndm-windows-post-task-'))
const downloads = join(root, 'downloads'); await mkdir(downloads)
const payload = Buffer.alloc(8 * 1024 * 1024, 0x73), submitted = Buffer.from([0,255,61,38])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const requests = []
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  requests.push({ method: req.method, range: req.headers.range ?? null, body: Buffer.concat(chunks).toString('hex'), contentType: req.headers['content-type'] })
  res.writeHead(200, { 'Content-Length': payload.length, 'Content-Type': 'application/octet-stream' })
  let offset = 0
  const timer = setInterval(() => { res.write(payload.subarray(offset, offset + 65536)); offset += 65536; if (offset >= payload.length) { clearInterval(timer); res.end() } }, 16)
  res.on('close', () => clearInterval(timer))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
await build({ entryPoints: ['src/main/windows/windowsEngine.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(root, 'engine.mjs') })
const { WindowsDownloadEngine } = await import(pathToFileURL(join(root, 'engine.mjs')))
async function freePort() { const s=tcpServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p }
let engine
const report = { root, scope: 'Windows task code with local aria2 on '+process.platform, requests, passed: false }
async function boot() {
  let status
  engine = new WindowsDownloadEngine({ stateDirectory: join(root,'state'), defaultDownloadDirectory: downloads, aria2Path: process.env.NDM_AUDIT_ARIA2 || '/opt/homebrew/bin/aria2c', ytDlpPath:'/unused', ffmpegPath:'/unused', rpcPort:await freePort() }, {
    onStatus(value) { status=value }, onEvent() {},
    inspectHTTPRepresentation: async () => { throw new Error('POST must not probe') },
    openHTTPResponse: (url, headers, signal, proxy, request) => { assert.equal(proxy, undefined); return fetch(url,{headers,signal,redirect:'manual',method:request?.method??'GET',...(request ? {body:request.body}: {})}) }
  })
  await engine.start(); assert.equal(status,'live')
}
async function until(id, predicate) {
  const deadline=Date.now()+20000
  while(Date.now()<deadline) { const task=(await engine.request('list')).tasks.find(t=>t.id===id); if(task && predicate(task)) return task; await delay(50) }
  throw new Error('Task timed out: '+JSON.stringify((await engine.request('list')).tasks))
}
try {
  await boot()
  const input = { url:`http://127.0.0.1:${server.address().port}/export`, filename:'post.bin', folderPath:downloads, method:'POST', postData:submitted.toString('base64'), headers:['Content-Type: application/octet-stream'], connections:8, autoStart:false }
  const added = await engine.request('add',input), id=added.task.id
  await engine.stop(); engine=undefined; await delay(300); await boot()
  await engine.request('resume',{taskID:id})
  await until(id,t=>t.status==='downloading' && t.completedBytes>=512*1024)
  await engine.request('pause',{taskID:id})
  const paused=await until(id,t=>t.status==='paused')
  report.pausedBytes=paused.completedBytes
  const partial=await readFile(join(downloads,'post.bin')), before=sha(partial)
  assert.equal(requests.length,1)
  await engine.stop(); engine=undefined; await delay(300); await boot()
  await assert.rejects(engine.request('resume',{taskID:id}),/不能自动续传/)
  await delay(200)
  assert.equal(requests.length,1); assert.equal(sha(await readFile(join(downloads,'post.bin'))),before)
  await engine.request('restart',{taskID:id})
  const completed=await until(id,t=>['complete','error'].includes(t.status))
  assert.equal(completed.status,'complete',JSON.stringify(completed))
  const bytes=await readFile(join(downloads,'post.bin')); assert.deepEqual(bytes,payload)
  assert.equal(requests.length,2)
  for (const request of requests) { assert.equal(request.method,'POST'); assert.equal(request.body,submitted.toString('hex')); assert.equal(request.range,null); assert.equal(request.contentType,'application/octet-stream') }
  report.sha256=sha(bytes); report.passed=true
} catch(error) { report.error=String(error); process.exitCode=1 }
finally {
  if(engine) await engine.stop()
  server.closeAllConnections(); await new Promise(r=>server.close(r))
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
}
