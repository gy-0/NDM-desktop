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

const root = mkdtempSync(join(tmpdir(), 'ndm-bootstrap-controls-audit-')), owned = join(root, 'owned')
const support = join(owned, 'support'), downloads = join(owned, 'downloads'), home = join(owned, 'home')
for (const directory of [support, downloads, home]) mkdirSync(directory, { recursive: true })
const hostPath = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/release/NDMHost')
const sha = data => createHash('sha256').update(data).digest('hex')
const payload = randomBytes(1024 * 1024), etag = `"${sha(payload)}"`
const report = { passed: false, root, scope: 'Observational bootstrap progress and bandwidth audit; isolated current release Host, synthetic local HTTP only', hostSHA256: sha(readFileSync(hostPath)) }
const expectFixed = true
const expectStreaming = process.argv.includes("--expect-streaming")
let host, exited, sequence = 0, generation = 0
const requests = []
const server = httpServer((req,res)=>{
  let body=''; req.on('data',chunk=>{body+=chunk}); req.on('end',()=>{
    const record={path:req.url,method:req.method,range:req.headers.range||null,requestBodyBytes:Buffer.byteLength(body),requestBodySHA:body?sha(Buffer.from(body)):null,responseBodyBytes:0};requests.push(record)
    if(req.method==='HEAD'){res.writeHead(req.url.startsWith('/control')?200:405,{'Content-Length':req.url.startsWith('/control')?payload.length:0});res.end();return}
    // Deliberately ignore Range and return the full file, including for form POST.
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':payload.length,ETag:etag})
    let offset=0;const timer=setInterval(()=>{if(res.destroyed){clearInterval(timer);return}const next=Math.min(payload.length,offset+65536);res.write(payload.subarray(offset,next));record.responseBodyBytes+=next-offset;offset=next;if(offset===payload.length){clearInterval(timer);res.end()}},20);res.on('close',()=>clearInterval(timer))
  })
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
try {
  await launch();assert.deepEqual((await rpc('list')).tasks,[])
  assert.equal((await rpc('updateSettings',{downloadDirectory:downloads,useCategoryFolders:false,bandwidthLimitBytesPerSecond:65536})).ok,true)
  report.configuredBytesPerSecond=65536
  report.cases=[]
  for(const scenario of ['CONTROL','GET','POST']){
    const method=scenario==='POST'?'POST':'GET'; const samples=[]; const started=Date.now()
    const path=`/${scenario.toLowerCase()}-probe.bin`
    const added=await rpc('add',{url:`http://127.0.0.1:${server.address().port}${path}`,folderPath:downloads,connections:2,method,...(method==='POST'?{body:'fixture=form',headers:['Content-Type: application/x-www-form-urlencoded']}:{})})
    assert.equal(added.ok,true)
    const completed=await until(async()=>{const t=await task(added.task.id);samples.push({elapsedMS:Date.now()-started,status:t?.status,bytes:t?.completedBytes,speed:t?.bytesPerSecond});if(t?.status==='error')throw Error('Fixture download failed');return t?.status==='complete'&&t},'Download did not complete',30000)
    const actualSHA=sha(readFileSync(join(completed.folderPath,completed.filename)))
    assert.equal(actualSHA,sha(payload))
    const observed=requests.filter(r=>r.path===path),bodies=observed.filter(r=>r.method===method)
    assert.equal(bodies.length,expectFixed?1:2,expectFixed?'Bootstrap must reuse the first full response':'Baseline should produce two complete body requests')
    assert.equal(bodies[0].range,scenario==='GET'?'bytes=0-0':null)
    assert.equal(bodies.reduce((n,r)=>n+r.responseBodyBytes,0),payload.length*(expectFixed?1:2))
    if(method==='POST')assert.ok(bodies.every(r=>r.requestBodySHA===sha(Buffer.from('fixture=form'))))
    report.cases.push({scenario,method,elapsedMS:Date.now()-started,samples,requests:observed,responseBodyBytes:bodies.reduce((n,r)=>n+r.responseBodyBytes,0),finalBytes:payload.length,finalSHA:actualSHA})
  }
  if(expectStreaming) {
    for(const result of report.cases) {
      assert.ok(result.elapsedMS>=14000, `${result.scenario} bypassed the 64 KiB/s cap`)
      assert.ok(result.samples.some(sample=>sample.bytes>0&&sample.bytes<payload.length), `${result.scenario} never reported in-flight progress`)
    }
  }
  report.streamingVerified=expectStreaming
  report.passed=true
}catch(error){report.error=error.message;throw error}
finally{
  let stopped=false
  try{await stop();stopped=true}finally{
    server.closeAllConnections();await new Promise(done=>server.close(done))
    if(stopped)rmSync(owned,{recursive:true,force:true})
    report.cleanedOwnedState=stopped
    writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
  }
}
