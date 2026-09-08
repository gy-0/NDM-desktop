// Isolated release Host investigation: one refused range must not kill healthy work.
import assert from 'node:assert/strict'
import {createServer as httpServer} from 'node:http'
import {createServer,createConnection} from 'node:net'
import {spawn} from 'node:child_process'
import {createHash,randomBytes} from 'node:crypto'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
const expectFixed=process.argv.includes('--expect-fixed')
const root=mkdtempSync(join(tmpdir(),'ndm-admission-audit-')),owned=join(root,'owned')
const support=join(owned,'support'),downloads=join(owned,'downloads'),home=join(owned,'home')
for(const dir of [support,downloads,home])mkdirSync(dir,{recursive:true})
const hostPath=resolve(process.env.NDM_QA_HOST_PATH||'/Applications/NDM.app/Contents/Resources/bin/NDMHost')
const sha=data=>createHash('sha256').update(data).digest('hex')
const payload=randomBytes(8*1024*1024),etag='"'+sha(payload)+'"',part=payload.length/8
const report={root,mode:expectFixed?'expect-fixed':'reproduce-bug',hostPath,hostSHA256:sha(readFileSync(hostPath)),requests:[],reproduced:false}
report.originalEvidence={
 arm64SHA256:'25031b78644cc3371ad81dd1e675550ae72e221d88f6c0ae167b434025cdc0c7',
 statusBranch:'0x10003a100 compare 400; 0x10003a104 greater -> 0x10003a32c; excludes 401/407/416 at 0x10003a32c/334/33c, 0x10003a340 -> 0x10003a468. Both 429 and 503 follow this branch.',
 budgetClear:'0x10003a46c calls 0x100024d08, which zeros engine+0x698 (startup budget).',
 error:'0x10003a664 calls 0x100024ffc(engine,socket,error,0). At 0x1000253bc engine state !=1 jumps 0x100025520; param4 zero -> 0x100025544 calls 0x1000532d0, not startup budget decrement.',
 recovery:'0x1000532d0 -> HTTP vtable+0x88=0x10003bd14; if resumable and work available, delayed single-worker requeue with 4500ms threshold. Nonresumable branch remains fatal.',
 scope:'Original evidence is current ARM64 static control flow, not a Neat 503 live run; this Host fixture exercises 503 only, with integer Retry-After 1.'
}
let host,exited,sequence=0,failures=0,healthyStarted=false
const started=Date.now()
const server=httpServer((req,res)=>{
 const match=req.headers.range?.match(/^bytes=(\d+)-(\d+)$/),start=match?Number(match[1]):0,end=match?Number(match[2]):payload.length-1
 const event={method:req.method,start,end,atMS:Date.now()-started,bytes:0,status:match?206:200,finished:false};report.requests.push(event)
 res.on('finish',()=>{event.finished=true;event.finishedAtMS=Date.now()-started})
 res.on('close',()=>{event.closedAtMS=Date.now()-started})
 const headers={'Content-Type':'application/octet-stream','Content-Length':end-start+1,'Accept-Ranges':'bytes',ETag:etag,...(match?{'Content-Range':`bytes ${start}-${end}/${payload.length}`}:{})}
 if(req.method==='HEAD'){res.writeHead(200,headers);res.end();return}
 if(start===part*7&&failures<4){
  const refuse=()=>{if(res.destroyed)return;if(!healthyStarted){setTimeout(refuse,5);return}failures++;event.status=503;res.writeHead(503,{'Content-Length':0,'Retry-After':'1'});res.end()};refuse();return
 }
 res.writeHead(event.status,headers)
 let offset=start,timer
 res.on('close',()=>clearTimeout(timer))
 const send=()=>{if(res.destroyed)return;const next=Math.min(offset+(start===0?8192:65536),end+1);res.write(payload.subarray(offset,next));event.bytes+=next-offset;offset=next;if(start===0)healthyStarted=true;if(offset>end)res.end();else timer=setTimeout(send,start===0?100:1)}
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
 assert.equal((await rpc('updateSettings',{downloadDirectory:downloads,useCategoryFolders:false,downloadAllAtOnce:true,smartConnectionsEnabled:false})).ok,true)
 const added=await rpc('add',{url:`http://127.0.0.1:${server.address().port}/file.bin`,folderPath:downloads,connections:8})
 assert.equal(added.ok,true)
 const observedLimits=[]
 const final=await until(async()=>{const t=await task(added.task.id);if(failures>0&&Number.isInteger(t?.requestLimit))observedLimits.push(t.requestLimit);return ['error','complete'].includes(t?.status)&&t},'Task did not settle',25000)
 report.observedRequestLimits=[...new Set(observedLimits)]
 await delay(100)
 report.task=final;report.failures=failures
 report.engineLog=readFileSync(join(support,String(final.id),'LogFile.txt'),'utf8')
 const healthy=report.requests.find(r=>r.method==='GET'&&r.start===0)
 report.reproduced=final.status==='error'&&failures===4&&healthy?.bytes>0&&!healthy.finished&&healthy.bytes<part
 if(expectFixed){
  assert.equal(final.status,'complete','Temporary 503 responses must remain recoverable')
  assert.equal(failures,4)
  assert.equal(report.requests.filter(r=>r.method==='GET'&&r.start===part*7).length,5,'Fifth request must succeed without another duplicate')
  assert.equal(report.requests.filter(r=>r.method==='GET'&&r.start===0).length,1,'Healthy request must not be restarted')
  // A live tail handoff may shorten the original response's write ownership.
  // It must not restart byte zero or turn the temporary refusal into task error.
  report.healthyTailHandedOff = !healthy.finished && report.engineLog.includes('TailHandoff: split segment 0;')
  assert.ok(healthy.finished || report.healthyTailHandedOff, 'Early original close must be explained by a live tail handoff')
  if (healthy.finished) assert.equal(healthy.bytes,part)
  else assert.ok(healthy.bytes > 0 && healthy.bytes < part, 'Live handoff retains an actual original prefix')
  assert.deepEqual(report.observedRequestLimits,[8],'503 must not reduce admission')
  report.finalSHA256=sha(readFileSync(join(final.folderPath,final.filename)))
  assert.equal(report.finalSHA256,sha(payload),'Final file must match complete payload')
  report.fixedVerified=true
 }else assert.equal(report.reproduced,true,'Expected four temporary refusals to cancel an unfinished healthy worker')
} catch(error){report.error=error.message;process.exitCode=1}
finally {
 let stopped=false
 try{await stop();stopped=true}finally{server.closeAllConnections();await new Promise(done=>server.close(done));if(stopped)rmSync(owned,{recursive:true,force:true});report.cleanedOwnedState=stopped;writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))}
}
