// Real Host zero-body startup audit; local HTTP and isolated task store only.
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const root = mkdtempSync(join(tmpdir(), 'ndm-starting-state-audit-')), owned = join(root, 'owned')
const home=join(owned,'home'),support=join(owned,'support'),downloads=join(owned,'downloads')
for(const path of [home,support,downloads])mkdirSync(path,{recursive:true})
const hostPath=resolve(process.env.NDM_QA_HOST_PATH||'native/.build/debug/NDMHost')
const hash=data=>createHash('sha256').update(data).digest('hex')
const payload=Buffer.alloc(65536);for(let i=0;i<payload.length;i++)payload[i]=i%251
const report={passed:false,root,hostPath,scope:'HEAD succeeds with strong ETag; real Range responds 206 headers then zero-body EOF; one configured connection',hostSHA256:hash(readFileSync(hostPath)),checks:[]}
let host,hostDone,sequence=0;const sockets=new Set()
const ranges = [], heads = []
const server=httpServer((req,res)=>{
 if(req.method==='HEAD') {
  heads.push(Date.now());res.writeHead(200,{'Content-Length':payload.length,'Accept-Ranges':'bytes',ETag:'"startup-zero-body-v1"'});res.end();return
 }
 const match=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
 if(!match){res.writeHead(400);res.end();return}
 const start=Number(match[1]),end=match[2]?Number(match[2]):payload.length-1
 ranges.push({at:Date.now(),start,end})
 res.writeHead(206,{'Connection':'close','Content-Length':end-start+1,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${payload.length}`,ETag:'"startup-zero-body-v1"'})
 // A clean TCP EOF after valid headers but before any promised body bytes.
 res.flushHeaders();res.end()
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
async function freePort(){const s=createServer();await new Promise(done=>s.listen(0,'127.0.0.1',done));const port=s.address().port;await new Promise(done=>s.close(done));return port}
const port=await freePort();let bridge=await freePort();while(bridge===port)bridge=await freePort()
function rpc(op,fields={}){return new Promise((done,reject)=>{
 const id=++sequence,s=createConnection({host:'127.0.0.1',port});let buffer='',settled=false
 const finish=(error,value)=>{if(settled)return;settled=true;s.destroy();error?reject(error):done(value)}
 s.setEncoding('utf8');s.setTimeout(3000,()=>finish(Error('rpc-timeout')));s.on('error',()=>finish(Error('rpc-error')));s.on('close',()=>finish(Error('rpc-closed')))
 s.on('connect',()=>s.write(JSON.stringify({id,op,...fields})+'\n'))
 s.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const value=JSON.parse(line);if(value.id===id)finish(null,value)}catch{finish(Error('rpc-json'))}}})
})}
async function until(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(40)}throw Error(label)}
async function launch(){
 host=spawn(hostPath,[],{cwd:owned,detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,CFFIXED_USER_HOME:home,TMPDIR:owned,LANG:'en_US.UTF-8',NDM_SUPPORT_DIR:support,NDM_HOST_PORT:String(port),NDM_BRIDGE_PORT:String(bridge),NDM_DISABLE_LEGACY_BRIDGE:'1'}})
 hostDone=new Promise(done=>{host.once('exit',done);host.once('error',done)})
 await until(async()=>(await rpc('ping').catch(()=>null))?.ok,'host-not-ready')
}
async function stopHost(){
 for(const socket of sockets)socket.close();sockets.clear()
 if(host?.pid){try{process.kill(-host.pid,'SIGTERM')}catch{};await Promise.race([hostDone,delay(1000)]);try{process.kill(-host.pid,'SIGKILL')}catch{};await hostDone
  await until(()=>{try{process.kill(-host.pid,0);return false}catch(error){return error.code==='ESRCH'}},'owned-host-group-remains',3000)
 }
}
let taskID
try {
 await launch();assert.deepEqual((await rpc('list')).tasks,[])
 const started=Date.now()
 const added=await rpc('add',{url:`http://127.0.0.1:${server.address().port}/startup.bin`,folderPath:downloads,connections:1})
 assert.ok(added.ok&&added.task?.id);taskID=added.task.id
 await until(()=>ranges.length>=5,'fewer-than-five-body-attempts',35000)
 const task=(await rpc('list')).tasks.find(t=>t.id===taskID)
 report.bodyRequestCount=ranges.length;report.headRequestCount=heads.length
 report.elapsedSeconds=(Date.now()-started)/1000;report.status=task.status
 report.completedBytes=task.completedBytes;report.requestOffsets=ranges.map(r=>r.start)
 assert.equal(task.status,'downloading');assert.equal(task.completedBytes,0)
 assert.ok(report.elapsedSeconds>=17,'Must observe repeated delayed recovery')
 report.passed=true
} catch(error) { report.failureCategory=error.message?.includes('fewer-than-five-body-attempts')?'fewer-than-five-body-attempts':'audit-failed' }
finally {
 if(taskID){
  const paused=await rpc('pause',{taskID});assert.ok(paused.ok)
  const task=(await rpc('list')).tasks.find(t=>t.id===taskID)
  report.pausedStatus=task?.status;assert.equal(task?.status,'paused')
 }
 await stopHost();server.closeAllConnections();await new Promise(done=>server.close(done))
 assert.ok(lstatSync(owned).isDirectory()&&!lstatSync(owned).isSymbolicLink());rmSync(owned,{recursive:true})
 report.ownedDataRemoved=true;writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
}
