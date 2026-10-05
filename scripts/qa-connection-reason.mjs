// Real Electron/React with an isolated engine fixture; no user files or downloads.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { completeOnboarding, isolateQAClipboard } from './qa-env.mjs'
const root = mkdtempSync(join(tmpdir(), 'ndm-connection-reason-'))
const task = {id:1,filename:'fixture.bin',title:'fixture.bin',url:'https://fixture.invalid/file.bin',folderPath:root,
 status:'downloading',category:'misc',fileSize:8000000,completedBytes:1000000,bytesPerSecond:100000,
 connections:8,activeRequests:1,requestLimit:1,segments:[]}
const sockets=new Set()
const server=createServer(socket=>{
 sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=''
 socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){
  const end=buffer.indexOf('\n'),request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1)
  const reply={id:request.id,ok:true}
  if(request.op==='list')reply.tasks=[task]
  if(request.op==='getSettings')reply.settings={downloadDirectory:root,maxConnections:8,maxConcurrentDownloads:4}
  socket.write(JSON.stringify(reply)+'\n')
 }})
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const publish=()=>sockets.forEach(socket=>socket.write(JSON.stringify({op:'snapshot',tasks:[task]})+'\n'))
const report={passed:false,root,scope:'Actual development Electron UI with synthetic engine events; not installed visual acceptance'}
let app
try {
 app=await electron.launch({args:['.','--mute-audio',`--user-data-dir=${join(root,'profile')}`],env:{...process.env,NDM_HOST_PORT:String(server.address().port),NDM_SUPPORT_DIR:join(root,'engine'),NDM_BRIDGE_PORT:'0'}})
 await isolateQAClipboard(app)
 const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');await completeOnboarding(page)
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.locator('[data-task-select="1"]').click()
 const pane=page.locator('#task-inspector')
 await pane.getByText('下载设置',{exact:true}).click()
 assert.equal(await pane.locator('#task-connections-reason').count(),0)
 report.reasons=[]
 for(const [reason,text] of [
  ['unverifiedResource','来源未提供可靠的文件版本信息，为保证文件完整性，当前使用单连接。'],
  ['rangeUnsupported','来源不支持分段下载，当前使用单连接。'],
  ['unknownLength','来源未提供文件大小，当前使用单连接。']
 ]) {
  task.connectionLimitReason=reason;publish()
  await pane.getByText(text,{exact:true}).waitFor()
  assert.ok((await pane.getByRole('group',{name:'任务连接数'}).getAttribute('aria-describedby')).includes('task-connections-reason'))
  report.reasons.push(reason)
 }
 task.connectionLimitReason='future-unknown-reason';publish()
 await pane.locator('#task-connections-reason').waitFor({state:'detached'})
 task.connectionLimitReason='unverifiedResource';publish()
 await pane.locator('#task-connections-reason').waitFor()
 // Use the actual resize handle, not injected layout styles.
 const before=await pane.boundingBox(),handle=await pane.getByRole('separator',{name:'调整任务详情宽度'}).boundingBox()
 await page.mouse.move(handle.x+handle.width/2,handle.y+150);await page.mouse.down()
 await page.mouse.move(handle.x+handle.width/2+before.width-280,handle.y+150,{steps:8});await page.mouse.up()
 await page.waitForTimeout(250)
 const geometry=await pane.getByRole('group',{name:'任务连接数'}).evaluate(el=>({width:el.clientWidth,content:el.scrollWidth}))
 assert.ok(geometry.content<=geometry.width+1,JSON.stringify(geometry));report.narrowGeometry=geometry
 await pane.locator('#task-connections-reason').scrollIntoViewIfNeeded()
 await page.screenshot({path:join(root,'single-connection-reason.png')})
 task.status='paused';publish();await pane.locator('#task-connections-reason').waitFor({state:'detached'})
 assert.deepEqual(errors,[])
 report.passed=true;report.unknownReasonIgnored=true;report.pausedReasonHidden=true
} finally {
 // This app owns only fixture tasks; exit without the real-download quit prompt.
 await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});for(const socket of sockets)socket.destroy();await new Promise(done=>server.close(done))
 writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
