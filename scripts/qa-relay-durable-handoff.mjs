// Real local WebSocket/Host receipt QA. No browser profile, media sites, or user library.
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const root = mkdtempSync(join(tmpdir(), 'ndm-relay-durable-host-')), owned = join(root, 'owned')
const home=join(owned,'home'),support=join(owned,'support'),downloads=join(owned,'downloads')
for(const path of [home,support,downloads])mkdirSync(path,{recursive:true})
const hostPath=resolve(process.env.NDM_QA_HOST_PATH||'native/.build/debug/NDMHost')
const hash=data=>createHash('sha256').update(data).digest('hex')
const payload=Buffer.alloc(65536);for(let i=0;i<payload.length;i++)payload[i]=i%251
const report={passed:false,root,scope:'Real Host and WebSocket, synthetic local file; protocol ACK/deduplication, not extension session storage',hostSHA256:hash(readFileSync(hostPath)),checks:[]}
let host,hostDone,sequence=0;const sockets=new Set()
const server=httpServer((req,res)=>{
 const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),start=range?Number(range[1]):0,end=range?.[2]?Number(range[2]):payload.length-1
 if(start>end||end>=payload.length){res.writeHead(416);res.end();return}
 res.writeHead(range?206:200,{'Content-Length':end-start+1,'Content-Type':'application/octet-stream','Accept-Ranges':'bytes',ETag:'"durable-local-v1"',...(range?{'Content-Range':`bytes ${start}-${end}/${payload.length}`}:{})})
 res.end(req.method==='HEAD'?undefined:payload.subarray(start,end+1))
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
async function connect(){
 const socket=new WebSocket(`ws://127.0.0.1:${bridge}/ndm/download`,'ndm.open.v1');sockets.add(socket)
 socket.messages=[];socket.addEventListener('message',event=>{if(typeof event.data==='string')socket.messages.push(event.data)})
 socket.addEventListener('error',()=>{})
 await until(()=>socket.readyState===1,'ws-open-timeout',3000)
 socket.send('NDMRelayHello:'+JSON.stringify({version:'1.4.10',protocol:1,role:'worker',durableHandoff:1}))
 const status=await until(()=>socket.messages.find(m=>m.startsWith('NDMRelayStatus:')),'status-timeout',3000)
 assert.equal(JSON.parse(status.slice('NDMRelayStatus:'.length)).durableHandoff,1,'durable-capability-missing')
 return socket
}
function send(socket,requestId,body){socket.send('NDMRelayDownload:'+JSON.stringify({requestId,payload:body}))}
async function exchange(socket,requestId,body){
 const index=socket.messages.length;send(socket,requestId,body)
 return until(()=>{for(const message of socket.messages.slice(index)){if(!message.startsWith('NDMRelayReceipt:'))continue;const receipt=JSON.parse(message.slice('NDMRelayReceipt:'.length));if(receipt.requestId===requestId)return receipt}return null},'receipt-timeout',5000)
}
const fileURL=`http://127.0.0.1:${server.address().port}/durable.bin`
const body=`1:GET\r\n2:${fileURL}\r\n6:normal\r\n7:${payload.length}\r\n8:application/octet-stream\r\n`
try{
 await launch();assert.deepEqual((await rpc('list')).tasks,[])
 assert.ok((await rpc('updateSettings',{downloadDirectory:downloads})).ok)
 assert.equal((await rpc('getSettings')).settings.downloadDirectory,downloads)
 const requestId=randomUUID();let socket=await connect()
 send(socket,requestId,body);socket.close() // Deliberately discard any receipt; graceful close still transmits the request.
 const original=await until(async()=>{const tasks=(await rpc('list')).tasks;assert.ok(tasks.length<=1);return tasks[0]?.status==='complete'&&tasks[0]},'first-task-not-complete')
 assert.equal(original.folderPath,downloads);assert.equal(hash(readFileSync(join(downloads,original.filename))),hash(payload))
 report.checks.push('first-submit-without-consuming-ack-completed')
 socket=await connect();let receipt=await exchange(socket,requestId,body)
 assert.equal(receipt.status,'accepted');assert.equal(receipt.taskId,original.id);assert.equal((await rpc('list')).tasks.length,1)
 report.checks.push('lost-ack-retry-one-task')
 await stopHost();await launch();socket=await connect();receipt=await exchange(socket,requestId,body)
 assert.equal(receipt.status,'accepted');assert.equal(receipt.taskId,original.id);assert.equal((await rpc('list')).tasks.length,1)
 report.checks.push('host-restart-same-receipt')
 receipt=await exchange(socket,requestId,body.replace('/durable.bin','/different.bin'))
 assert.equal(receipt.status,'rejected');assert.equal((await rpc('list')).tasks.length,1)
 report.checks.push('same-id-different-payload-rejected')
 receipt=await exchange(socket,randomUUID(),body);assert.equal(receipt.status,'accepted');assert.notEqual(receipt.taskId,original.id)
 await until(async()=>(await rpc('list')).tasks.length===2,'new-id-missing')
 report.checks.push('same-url-new-id-new-task')
 assert.ok((await rpc('remove',{taskID:original.id,deleteFile:false})).ok)
 receipt=await exchange(socket,requestId,body);assert.equal(receipt.status,'deleted');assert.equal((await rpc('list')).tasks.length,1)
 report.checks.push('deleted-task-not-recreated')
 receipt=await exchange(socket,randomUUID(),`1:GET\r\n2:http://127.0.0.1:${server.address().port}/watch\r\n6:media-page\r\n`)
 assert.equal(receipt.status,'rejected');assert.ok(/unsupported/.test(String(receipt.error)),'media-error-not-unsupported');assert.equal((await rpc('list')).tasks.length,1)
 report.checks.push('media-page-rejected-without-file-task')
 report.finalSHA256=hash(payload);report.bytes=payload.length;report.passed=true
}catch(error){report.failureCategory=['durable-capability-missing','first-task-not-complete','receipt-timeout','host-not-ready','media-error-not-unsupported'].find(s=>error.message?.includes(s))||'contract-failed'}
finally{
 await stopHost();server.closeAllConnections();await new Promise(done=>server.close(done))
 assert.ok(lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink());assert.ok(lstatSync(owned).isDirectory()&&!lstatSync(owned).isSymbolicLink());rmSync(owned,{recursive:true})
 report.ownedDataRemoved=true;writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
}
