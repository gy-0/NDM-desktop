// Real isolated Host lifecycle, without replacing or launching /Applications/NDM.app.
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createPauseSession } from './deploy-mac-lifecycle.mjs'

const root = mkdtempSync(join(tmpdir(), 'ndm-deploy-resume-')), owned = join(root, 'owned')
const support = join(owned, 'support'), downloads = join(owned, 'downloads'), home = join(owned, 'home')
for (const directory of [support, downloads, home]) mkdirSync(directory, { recursive: true })
const hostPath = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
const sha = data => createHash('sha256').update(data).digest('hex')
const payload = randomBytes(6 * 1024 * 1024), etag = `"${sha(payload)}"`
const changedResource = process.argv.includes('--changed-resource')
const replacement = Buffer.from(payload); replacement[0] ^= 1
const report = { passed: false, root, scope: 'Isolated Host restart and deployment pause helper; no installed app changes', hostSHA256: sha(readFileSync(hostPath)) }
let rendererFixture
let host, exited, sequence = 0, generation = 0
const requests = []
const server = httpServer((req, res) => {
  const servedPayload = changedResource && generation > 1 ? replacement : payload
  const servedETag = changedResource && generation > 1 ? `"${sha(replacement)}"` : etag
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : payload.length - 1
  requests.push({ generation, path: req.url, method: req.method, start, end })
  if (start > end || end >= payload.length) { res.writeHead(416); res.end(); return }
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end-start+1, 'Accept-Ranges': 'bytes', ETag: servedETag, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  if (req.method === 'HEAD') { res.end(); return }
  let offset = start, timer
  res.on('close', () => clearTimeout(timer))
  const send = () => {
    if (res.destroyed) return
    const next = Math.min(offset+32768, end+1)
    res.write(servedPayload.subarray(offset,next)); offset=next
    if(offset>end)res.end();else timer=setTimeout(send,generation>1?2:25)
  }
  send()
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
async function freePort() { const s=createServer();await new Promise(done=>s.listen(0,'127.0.0.1',done));const p=s.address().port;await new Promise(done=>s.close(done));return p }
const port=await freePort();let bridge=await freePort();while(bridge===port)bridge=await freePort()
function rpc(op, fields={}, timeout=5000) {
  return new Promise((done,reject)=>{
    const id=++sequence,s=createConnection({host:'127.0.0.1',port});let buffer='',settled=false
    const finish=(error,value)=>{if(settled)return;settled=true;s.destroy();error?reject(error):done(value)}
    s.setEncoding('utf8');s.setTimeout(timeout,()=>finish(Error('RPC timeout')));s.on('error',()=>finish(Error('RPC connection failed')));s.on('close',()=>finish(Error('RPC closed')))
    s.on('connect',()=>s.write(JSON.stringify({id,op,...fields})+'\n'))
    s.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const value=JSON.parse(line);if(value.id===id)finish(null,value)}catch{finish(Error('Invalid RPC JSON'))}}})
  })
}
async function until(fn,label,timeout=15000) {const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(50)}throw Error(label)}
async function launch() {
  generation++
  host=spawn(hostPath,[],{cwd:owned,stdio:'ignore',env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,CFFIXED_USER_HOME:home,TMPDIR:owned,LANG:'en_US.UTF-8',NDM_SUPPORT_DIR:support,NDM_HOST_PORT:String(port),NDM_BRIDGE_PORT:String(bridge),NDM_DISABLE_LEGACY_BRIDGE:'1'}})
  exited=new Promise(done=>{host.once('exit',done);host.once('error',done)})
  await until(async()=> (await rpc('ping').catch(()=>null))?.ok,'Host not ready')
}
async function stop() {
  if(!host || host.exitCode!==null || host.signalCode!==null)return
  host.kill('SIGTERM')
  await Promise.race([exited,delay(5000).then(()=>{throw Error('Host did not exit normally; no force kill')})])
}
async function task(id) {return (await rpc('list')).tasks.find(t=>t.id===id)}
async function add(name) {
  const reply=await rpc('add',{url:`http://127.0.0.1:${server.address().port}/${name}.bin`,folderPath:downloads,connections:1})
  assert.equal(reply.ok,true)
  const id=reply.task.id
  await until(async()=>{const t=await task(id);return t?.status==='downloading'&&t.completedBytes>=65536},'No partial transfer')
  return id
}
const lifecycle=createPauseSession({rpc})
try {
  await launch();assert.deepEqual((await rpc('list')).tasks,[])
  assert.equal((await rpc('updateSettings',{downloadDirectory:downloads,useCategoryFolders:false,downloadAllAtOnce:true})).ok,true)
  const alreadyPaused=await add('original-paused')
  assert.equal((await rpc('pause',{taskID:alreadyPaused})).ok,true)
  const active=await add('active')
  await lifecycle.pauseActive();await lifecycle.assertDrained()
  assert.deepEqual([...lifecycle.pausedIDs],[active])
  assert.equal((await task(alreadyPaused)).status,'paused');assert.equal((await task(active)).status,'paused')
  const receiptPath=join(support,String(active),'offset-storage-v2.json')
  const receipt=JSON.parse(readFileSync(receiptPath,'utf8'))
  const prefix=receipt.ranges.reduce((n,r)=>n+r.durablePrefix,0)
  assert.ok(prefix>0&&prefix<payload.length)
  const partial=join(receipt.parentPath,receipt.partialName)
  const before=sha(readFileSync(partial)),metadata=readFileSync(receiptPath,'utf8')
  await delay(300)
  assert.equal(sha(readFileSync(partial)),before,'Pause ACK must drain payload writes')
  assert.equal(readFileSync(receiptPath,'utf8'),metadata,'Checkpoint must remain stable after pause ACK')
  await stop();await launch()
  assert.equal((await task(active)).status,'paused');assert.equal((await task(alreadyPaused)).status,'paused')
  await lifecycle.restore()
  if (changedResource) {
    const failed = await until(async()=>{ const t=await task(active); return t?.status==='error'&&t }, 'Changed representation was not rejected')
    assert.equal(failed.errorText, '#diag:downloadRecordChanged')
    assert.equal(sha(readFileSync(partial)), before, 'Changed resource must not alter retained bytes')
    const attempts = requests.length
    assert.equal((await rpc('resume',{taskID:active})).ok,true)
    await until(async()=>{ const t=await task(active); return t?.status==='error'&&requests.length>attempts }, 'Repeated resume must still reject changed representation')
    assert.equal(sha(readFileSync(partial)),before)
    assert.equal((await task(alreadyPaused)).status,'paused')
    Object.assign(report,{passed:true,changedResourceRejected:true,repeatedResumeStillFails:true,oldBytesPreserved:true,diagnostic:failed.diagnostic,durablePrefix:prefix})
    if (!process.argv.includes('--baseline-only')) {
      assert.equal(failed.canRedownloadChangedResource,true)
      const intent={taskID:active,expectedURL:failed.url,expectedGeneration:failed.recoveryGeneration??0}
      assert.equal((await rpc('redownloadChangedResource',intent)).ok,false,'No implicit confirmation')
      assert.equal(sha(readFileSync(partial)),before)
      if (process.argv.includes('--browser-ui')) {
        const { startRendererHostFixture } = await import('./qa-renderer-host-fixture.mjs')
        rendererFixture=await startRendererHostFixture(rpc)
        console.log(JSON.stringify({uiReady:true,url:rendererFixture.url,taskID:active,filename:failed.filename}))
      } else assert.equal((await rpc('redownloadChangedResource',{...intent,confirmed:true})).ok,true)
      const delivered=await until(async()=>{const t=await task(active);return t?.status==='complete'&&t},'Confirmed redownload did not complete',process.argv.includes('--browser-ui')?120000:15000)
      assert.equal(delivered.recoveryGeneration,1)
      assert.equal(delivered.filename,failed.filename)
      assert.equal(delivered.folderPath,failed.folderPath)
      assert.equal(sha(readFileSync(join(delivered.folderPath,delivered.filename))),sha(replacement))
      assert.equal(sha(readFileSync(partial)),before,'Old checkpoint bytes must survive successful redownload')
      assert.equal(readFileSync(receiptPath,'utf8'),metadata)
      assert.equal((await rpc('list')).tasks.length,2)
      assert.equal((await rpc('redownloadChangedResource',{...intent,confirmed:true})).ok,false,'Stale confirmation must not replay')
      Object.assign(report,{sameTaskRedownload:true,oldReceiptPreserved:true,newRepresentationSHA:sha(replacement),replayedConfirmationRejected:true})
      if (rendererFixture) { report.browserConfirmations=rendererFixture.calls.filter(op=>op==='redownloadChangedResource').length; await delay(15000) }
    }

  } else {
  const completed=await until(async()=>{const t=await task(active);return t?.status==='complete'&&t},'Restored task did not complete')
  assert.equal((await task(alreadyPaused)).status,'paused')
  const finalSHA=sha(readFileSync(join(completed.folderPath,completed.filename)))
  assert.equal(finalSHA,sha(payload))
  const resumed=requests.filter(r=>r.generation===2&&r.path==='/active.bin'&&r.method==='GET')
  assert.ok(resumed.some(r=>r.start===prefix),'HTTP must resume exactly the durable prefix')
  assert.equal(requests.filter(r=>r.generation===2&&r.path==='/original-paused.bin').length,0,'Previously paused task must not issue even a probe')
  Object.assign(report,{passed:true,activeTaskID:active,originalPausedTaskID:alreadyPaused,durablePrefix:prefix,restoredHTTP:resumed,finalSHA,originalRemainedPaused:true,writerDrained:true})
  }
} catch(error) {report.error=error.message;throw error}
finally {
  let stopped=false
  try {await stop();stopped=true} finally {
    await rendererFixture?.close()
    server.closeAllConnections();await new Promise(done=>server.close(done))
    if(stopped)rmSync(owned,{recursive:true,force:true})
    report.cleanedOwnedState=stopped
    writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
  }
}
