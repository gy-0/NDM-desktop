// Actual Windows orchestration + isolated local aria2; can run on macOS, not Windows OS proof.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
const root = await mkdtemp(join(tmpdir(), 'ndm-windows-mirror-identity-'))
const downloads = join(root, 'downloads'); await mkdir(downloads)
const payloads = [Buffer.alloc(8 * 1024 * 1024, 0x41), Buffer.alloc(8 * 1024 * 1024, 0x42)]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const requests = []
const server = createServer((req, res) => {
  const primary=req.url.startsWith('/primary'), body=payloads[primary?0:1]
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start=range?Number(range[1]):0, end=range?.[2]?Math.min(Number(range[2]),body.length-1):body.length-1
  requests.push({path:req.url,method:req.method,range:req.headers.range??null})
  res.writeHead(range?206:200,{'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${body.length}`}:{})})
  let offset=start
  const timer=setInterval(()=>{
    if(primary && offset>=2*1024*1024){clearInterval(timer);res.destroy();return}
    const next=Math.min(offset+65536,end+1);res.write(body.subarray(offset,next));offset=next
    if(offset>end){clearInterval(timer);res.end()}
  },8)
  res.on('close',()=>clearInterval(timer))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
await build({ entryPoints: ['src/main/windows/windowsEngine.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(root, 'engine.mjs') })
const { WindowsDownloadEngine } = await import(pathToFileURL(join(root, 'engine.mjs')))
async function freePort() { const s=tcpServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p }
let engine
const report = { root, scope: 'Unvalidated mirrors in Windows task code with local aria2 on '+process.platform, requests, observed: false }
async function boot() {
  let status
  engine = new WindowsDownloadEngine({ stateDirectory: join(root,'state'), defaultDownloadDirectory: downloads, aria2Path: process.env.NDM_AUDIT_ARIA2 || '/opt/homebrew/bin/aria2c', ytDlpPath:'/unused', ffmpegPath:'/unused', rpcPort:await freePort() }, {
    onStatus(value) { status=value }, onEvent() {},
    inspectHTTPRepresentation: async () => undefined,
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
  const base=`http://127.0.0.1:${server.address().port}`
  const added=await engine.request('add',{creationKey:randomUUID(),url:base+'/primary',mirrors:[base+'/backup'],filename:'mirror.bin',folderPath:downloads,connections:8})
  assert.equal(added.ok,true)
  const terminal=await until(added.task.id,t=>['complete','error'].includes(t.status))
  if (process.argv.includes('--expect-guard')) {
    assert.equal(terminal.status,'error'); assert.match(terminal.errorText,/镜像/); assert.equal(requests.length,0)
    await assert.rejects(readFile(join(downloads,'mirror.bin')), {code:'ENOENT'})
    const partial=payloads[0].subarray(0,2*1024*1024), path=join(downloads,'mirror.bin')
    await writeFile(path,partial); await writeFile(path+'.aria2','synthetic-owned-sidecar')
    const record=engine.tasks.find(t=>t.id===added.task.id); record.status='paused';record.completedBytes=partial.length
    await engine.persist();await engine.stop();engine=undefined;await delay(300);await boot()
    for (const op of ['resume','restart']) await assert.rejects(engine.request(op,{taskID:added.task.id}),/镜像地址尚未验证/)
    assert.deepEqual(await readFile(path),partial)
    assert.equal(await readFile(path+'.aria2','utf8'),'synthetic-owned-sidecar')
    assert.equal(requests.length,0)
    report.guardVerified=true;report.preservedPartialSHA256=sha(partial)
  } else {
  const bytes=await readFile(join(downloads,'mirror.bin'))
  report.status=terminal.status; report.errorText=terminal.errorText
  report.bytes=bytes.length;report.sha256=sha(bytes)
  report.matchesPrimary=bytes.equals(payloads[0]);report.matchesBackup=bytes.equals(payloads[1])
  report.mixed=bytes.includes(0x41)&&bytes.includes(0x42)
  report.falseCompletion=terminal.status==='complete'&&!report.matchesPrimary&&!report.matchesBackup
  }
  report.observed=true
} catch(error) { report.error=String(error); process.exitCode=1 }
finally {
  if(engine) await engine.stop()
  server.closeAllConnections(); await new Promise(r=>server.close(r))
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
}
