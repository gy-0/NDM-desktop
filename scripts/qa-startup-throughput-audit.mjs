// Real isolated Host lifecycle, without replacing or launching /Applications/NDM.app.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'ndm-startup-throughput-')), owned = join(root, 'owned')
const support = join(owned, 'support'), downloads = join(owned, 'downloads'), home = join(owned, 'home')
for (const directory of [support, downloads, home]) mkdirSync(directory, { recursive: true })
const hostPath = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/release/NDMHost')
const sha = data => createHash('sha256').update(data).digest('hex')
const payload = randomBytes(8 * 1024 * 1024), etag = `"${sha(payload)}"`
const report = { passed: false, root, scope: 'Isolated release Host and local HTTP; probe behavior evidence, no product or installed-app changes', hostSHA256: sha(readFileSync(hostPath)) }
const expectFixed = process.argv.includes("--expect-fixed")
let host, exited, sequence = 0, generation = 0
const requests = []
const server = httpServer(async (req,res)=>{
  const record={path:req.url,method:req.method,range:req.headers.range||null,at:Date.now(),firstBodyAt:null,responseBodyBytes:0};requests.push(record)
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start=range?Number(range[1]):0, end=range?.[2]?Math.min(Number(range[2]),payload.length-1):payload.length-1
  if(req.method==='HEAD' && req.url.includes('slow-head')) await delay(1500)
  if(res.destroyed)return
  res.writeHead(range?206:200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="fixture.bin"',
    'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(!req.url.includes('no-validator')?{ETag:etag}:{}),
    ...(range?{'Content-Range':`bytes ${start}-${end}/${payload.length}`}:{})})
  if(req.method==='HEAD'){res.end();return}
  let offset=start
  const timer=setInterval(()=>{if(res.destroyed){clearInterval(timer);return}const next=Math.min(end+1,offset+65536);record.firstBodyAt??=Date.now();res.write(payload.subarray(offset,next));record.responseBodyBytes+=next-offset;offset=next;if(offset===end+1){clearInterval(timer);res.end()}},30)
  res.on('close',()=>clearInterval(timer))
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
  assert.equal((await rpc('updateSettings',{downloadDirectory:downloads,useCategoryFolders:false})).ok,true)
  report.cases=[]
  report.scope='Controlled loopback latency and per-request bandwidth; real Chrome headless download vs isolated native release Host. Not an Internet speed claim.'
  for(const scenario of ['strong-one','strong-eight','no-validator','slow-head']){
    const samples=[],started=Date.now(),path=`/${scenario}.bin`
    const added=await rpc('add',{url:`http://127.0.0.1:${server.address().port}${path}`,folderPath:downloads,connections:scenario==='strong-one'?1:8})
    assert.equal(added.ok,true)
    const completed=await until(async()=>{const t=await task(added.task.id);samples.push({elapsedMS:Date.now()-started,bytes:t?.completedBytes,connections:t?.activeRequests});if(t?.status==='error')throw Error('Fixture download failed');return t?.status==='complete'&&t},'Download did not complete',30000)
    assert.equal(sha(readFileSync(join(completed.folderPath,completed.filename))),sha(payload))
    const observed=requests.filter(r=>r.path===path)
    report.cases.push({scenario,elapsedMS:Date.now()-started,firstRequestMS:observed[0].at-started,
      firstServerBodyMS:Math.min(...observed.filter(r=>r.firstBodyAt).map(r=>r.firstBodyAt))-started,
      firstVisibleProgressMS:samples.find(s=>s.bytes>0)?.elapsedMS,requests:observed,samples})
  }
  const browser=await chromium.launch({channel:'chrome',headless:true})
  try {
    const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage()
    const started=Date.now(),path='/chrome-slow-head.bin'
    const downloadEvent=page.waitForEvent('download')
    await page.goto(`http://127.0.0.1:${server.address().port}${path}`).catch(error=>{if(!/ERR_ABORTED|Download is starting/.test(String(error)))throw error})
    const download=await downloadEvent,final=join(downloads,'chrome.bin')
    await download.saveAs(final)
    assert.equal(sha(readFileSync(final)),sha(payload))
    const observed=requests.filter(r=>r.path===path)
    report.cases.push({scenario:'Chrome direct download, same slow-HEAD endpoint',browserVersion:browser.version(),elapsedMS:Date.now()-started,
      firstServerBodyMS:Math.min(...observed.filter(r=>r.firstBodyAt).map(r=>r.firstBodyAt))-started,requests:observed})
  }finally{await browser.close()}
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
