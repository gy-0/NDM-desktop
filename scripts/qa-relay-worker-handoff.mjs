// Real isolated Host + real Node WebSocket + complete worker in VM; Chrome APIs are stubs.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const root = mkdtempSync(join(tmpdir(), 'ndm-relay-worker-host-')), owned = join(root, 'owned')
const home = join(owned, 'home'), support = join(owned, 'support'), downloads = join(owned, 'downloads')
for (const p of [home, support, downloads]) mkdirSync(p, { recursive: true })
const hostPath = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
const bgPath = resolve(process.env.NDM_QA_BACKGROUND || 'extension/NDMRelay/bg.js')
const hash = data => createHash('sha256').update(data).digest('hex')
const payload = Buffer.alloc(65536); for (let i = 0; i < payload.length; i++) payload[i] = i % 251
const report = { passed: false, root, scope: 'Complete bg.js VM, Chrome stubs, real WebSocket and isolated Host/local HTTP; no browser UI/profile', hostSHA256: hash(readFileSync(hostPath)), workerSHA256: hash(readFileSync(bgPath)), expectedSHA256: hash(payload) }
let host, hostDone, worker, sequence = 0, socketCount = 0, downloadSendAttempts = 0, requests = 0
const sockets = [], timers = new Set(), handoffEvents = [], sessionData = {}
const server = httpServer((req, res) => {
  requests++
  const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/), start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : payload.length - 1
  if (start > end || end >= payload.length) { res.writeHead(416); res.end(); return }
  res.writeHead(match ? 206 : 200, { 'Content-Length': end-start+1, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: '"relay-fixture-v1"', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  res.end(req.method === 'HEAD' ? undefined : payload.subarray(start, end+1))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
async function freePort() { const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done)); const p = s.address().port; await new Promise(done => s.close(done)); return p }
const port = await freePort(); let bridge = await freePort(); while (bridge === port) bridge = await freePort()
function rpc(op, fields = {}) { return new Promise((done, reject) => {
  const id = ++sequence, s = createConnection({ host: '127.0.0.1', port }); let buffer = '', settled = false
  const finish = (error, reply) => { if (settled) return; settled = true; s.destroy(); error ? reject(error) : done(reply) }
  s.setEncoding('utf8'); s.setTimeout(3000, () => finish(Error('RPC timeout'))); s.on('error', () => finish(Error('RPC failed'))); s.on('close', () => finish(Error('RPC closed')))
  s.on('connect', () => s.write(JSON.stringify({ id, op, ...fields })+'\n'))
  s.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const i=buffer.indexOf('\n'), line=buffer.slice(0,i); buffer=buffer.slice(i+1); try { const r=JSON.parse(line); if(r.id===id)finish(null,r) }catch{finish(Error('RPC JSON'))} } })
}) }
async function until(fn, label, milliseconds = 12000) { const end = Date.now()+milliseconds; while(Date.now()<end) { const value=await fn(); if(value)return value; await delay(50) } throw Error(label) }
try {
  host = spawn(hostPath, [], { cwd: owned, detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: owned, LANG: 'en_US.UTF-8', NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(port), NDM_BRIDGE_PORT: String(bridge), NDM_DISABLE_LEGACY_BRIDGE: '1' } })
  hostDone = new Promise(done => { host.once('exit',done); host.once('error',done) })
  await until(async () => (await rpc('ping').catch(()=>null))?.ok, 'Host not ready')
  assert.deepEqual((await rpc('list')).tasks, [])
  assert.ok((await rpc('updateSettings', { downloadDirectory: downloads })).ok)
  assert.equal((await rpc('getSettings')).settings.downloadDirectory, downloads)
  const event = () => ({ addListener() {} })
  const chrome = {
    action: { onClicked:event(), setBadgeBackgroundColor(){}, setBadgeText(){}, setTitle(){} },
    contextMenus: { onClicked:event(), removeAll(cb){cb()}, create(){}, update(){} },
    cookies: { getAll(_,cb){cb([])} }, downloads: { onCreated:event(), async pause(){handoffEvents.push('pause')}, async cancel(){handoffEvents.push('cancel')}, async erase(){handoffEvents.push('erase')}, async search(){return []}, async resume(){handoffEvents.push('resume')} },
    runtime: { lastError:null, onConnect:event(), onMessage:event() }, i18n:{getMessage(){return ''}},
    storage:{session:process.argv.includes('--durable')?{async get(){return structuredClone(sessionData)},async set(value){Object.assign(sessionData,structuredClone(value))}}:undefined,local:{get(_,cb){cb({})},set(_,cb){cb?.()}}}, tabs:{query(_,cb){cb([])},remove(){}},
    webNavigation:{onHistoryStateUpdated:event()}, webRequest:{onBeforeRequest:event(),onBeforeSendHeaders:event(),onCompleted:event(),onErrorOccurred:event(),onHeadersReceived:event()}
  }
  class LocalWebSocket extends WebSocket {
    constructor(_url, protocol) { super(`ws://127.0.0.1:${bridge}/ndm/download`, protocol); sockets.push(this); socketCount++ }
    send(message) { if(String(message).startsWith('1:')||String(message).startsWith('NDMRelayDownload:'))downloadSendAttempts++; super.send(message) }
  }
  const context = vm.createContext({ crypto:globalThis.crypto, chrome, WebSocket:LocalWebSocket, URL, Headers, AbortController, fetch, console:{log(){},warn(){},error(){}}, navigator:{userAgent:'NDM isolated QA'},
    setTimeout(fn,ms,...args){const timer=setTimeout(fn,ms,...args);timers.add(timer);return timer}, clearTimeout, setInterval(fn,ms,...args){const timer=setInterval(fn,ms,...args);timers.add(timer);return timer}, clearInterval })
  context.importScripts = (...files) => { for(const f of files)vm.runInContext(readFileSync(join('extension/NDMRelay',f),'utf8'),context,{filename:f}) }
  vm.runInContext(readFileSync(bgPath,'utf8'),context,{filename:'bg.js'}); worker=context.NDM_BG
  await until(()=>worker.D && worker.G?.readyState===1,'Initial WebSocket failed')
  if(process.argv.includes('--durable')) {
    await until(()=>worker.bridgeStatus?.durableHandoff===1,'Durable handshake failed');
    const url=`http://127.0.0.1:${server.address().port}/relay-fixture.bin`;
    const id=worker.browserHandoffs.begin(url); worker.browserHandoffs.attach({id:1,url,paused:false});
    await worker.I({'1':'GET','2':url,'6':'normal',browserHandoffID:id});
    await until(()=>handoffEvents.includes('erase'),'Receipt cleanup failed');
    assert.deepEqual(handoffEvents,['pause','cancel','erase']);
    report.handoffEvents=handoffEvents;
  } else {
  const stale=worker.G
  // Suppress the close callback to reproduce stale D=true after a sleeping worker.
  stale.onclose=null; stale.close()
  await until(()=>stale.readyState===3,'Socket did not close'); worker.D=true
  assert.equal(worker.G,stale); assert.equal(stale.readyState,3)
  await worker.I({ '1':'GET','2':`http://127.0.0.1:${server.address().port}/relay-fixture.bin`,'6':'normal','7':payload.length,'8':'application/octet-stream',cookies:'synthetic=value' })
  }
  const task=await until(async()=>{const tasks=(await rpc('list')).tasks; assert.ok(tasks.length<=1,'Duplicate task'); if(tasks[0]?.status==='error')throw Error('Host download failed');return tasks[0]?.status==='complete'&&tasks[0]},'Handoff did not complete')
  assert.equal(task.folderPath,downloads)
  const file=resolve(task.folderPath,task.filename); assert.ok(file.startsWith(downloads+'/'))
  assert.equal(hash(readFileSync(file)),report.expectedSHA256)
  await delay(250); assert.equal((await rpc('list')).tasks.length,1); assert.equal(downloadSendAttempts,1); assert.ok(socketCount>=(process.argv.includes('--durable')?1:2))
  if (process.argv.includes('--overflow')) {
    const reconnect = worker.M, retry = worker.scheduleBridgeRetry
    worker.M = () => {}; worker.scheduleBridgeRetry = () => {}
    const connection = worker.G; connection.onclose = null; connection.close()
    await until(()=>connection.readyState===3,'Queue fixture socket did not close')
    worker.G=null; worker.D=false
    const intents = Array.from({length:22},(_,i)=>({'1':'GET','2':`http://127.0.0.1:${server.address().port}/queued-${i}.bin`,'3':`queued-${i}.bin`,'6':'normal','7':payload.length,'8':'application/octet-stream'}))
    const results = []
    for(const intent of intents) results.push(await worker.I(intent))
    report.overflowQueueLength=worker.pendingRelayQueue.length
    report.oldestRetained=worker.pendingRelayQueue[0]?.['2']===intents[0]['2']
    assert.equal(worker.pendingRelayQueue.length,21,'Bounded queue must preserve accepted intents')
    assert.equal(worker.pendingRelayQueue[0]['2'],intents[0]['2'],'Oldest accepted request was silently evicted')
    assert.ok(!worker.pendingRelayQueue.includes(intents[21]),'Overflow must not replace an accepted item')
    assert.equal(results[21]?.accepted,false,'Overflow must report rejection')
    assert.equal(results[21]?.error,'queue-full')
    worker.M=reconnect; worker.scheduleBridgeRetry=retry; worker.M()
    const acceptedTasks=await until(async()=>{
      const rows=(await rpc('list')).tasks
      assert.ok(rows.length<=22,'Duplicate accepted tasks')
      return rows.length===22 && rows.every(row=>row.status==='complete') && rows
    },'Accepted queue did not fully recover',60000)
    for(const row of acceptedTasks) assert.equal(hash(readFileSync(join(row.folderPath,row.filename))),report.expectedSHA256)
    assert.equal(downloadSendAttempts,22,'Each accepted intent must be sent once')
    await worker.I(intents[21])
    const retriedTasks=await until(async()=>{const rows=(await rpc('list')).tasks;return rows.length===23 && rows.every(row=>row.status==='complete') && rows},'Rejected request did not recover after retry',20000)
    const retried=retriedTasks.find(row=>row.filename==='queued-21.bin')
    assert.ok(retried); assert.equal(hash(readFileSync(join(retried.folderPath,retried.filename))),report.expectedSHA256)
    assert.equal(downloadSendAttempts,23)
    Object.assign(report,{overflowAccepted:21,overflowRejected:1,oldestRetained:true,rejectedRetryCompleted:true,allTaskCount:23})
  }
  Object.assign(report,{passed:true,actualSHA256:hash(readFileSync(file)),bytes:payload.length,socketCount,downloadSendAttempts,httpRequests:requests,taskCount:process.argv.includes('--overflow') ? 23 : 1})
} catch (error) { report.failure=['Handoff did not complete','Initial WebSocket failed','Host not ready','Host download failed'].includes(error.message)?error.message:'handoff-contract-failed'; report.socketCount=socketCount;report.downloadSendAttempts=downloadSendAttempts }
finally {
  for(const timer of timers)clearTimeout(timer)
  for(const socket of sockets){socket.onclose=null;socket.onerror=null;socket.close()}
  if(host?.pid){try{process.kill(-host.pid,'SIGTERM')}catch{};await Promise.race([hostDone,delay(1000)]);try{process.kill(-host.pid,'SIGKILL')}catch{};await hostDone}
  server.closeAllConnections();await new Promise(done=>server.close(done))
  assert.ok(lstatSync(owned).isDirectory()&&!lstatSync(owned).isSymbolicLink());rmSync(owned,{recursive:true})
  report.ownedDataRemoved=true;writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
}
