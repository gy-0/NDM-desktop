// Renderer and IPC QA with an isolated engine fixture. No real task or file is removed.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'
const root = mkdtempSync(join(tmpdir(), 'ndm-detail-actions-'))
const file = join(root, 'Workshop.pdf')
writeFileSync(file, 'NDM isolated file-action fixture')
const icon = 'data:image/png;base64,' + readFileSync('build/ndm-icon.png').toString('base64')
const make = (id, filename, status) => ({id,filename,title:filename,folderPath:root,url:`https://downloads.example.test/${filename}?token=${'long-download-parameter-'.repeat(20)}`,pageURL:'https://example.test/releases/2026/09',source:'example.test',category:'document',status,fileSize:24000000,completedBytes:status==='complete'?24000000:0,bytesPerSecond:0,connections:4,segments:[],activityAt:Date.now()-id*1000,...(status==='error'?{errorText:'Failed',diagnostic:{title:'下载链接已失效',message:'请从来源网页重新下载。',primaryAction:'openPage'}}:{})})
let tasks = [make(1,'Workshop.pdf','complete'),make(2,'研究资料与项目文件：很长的文件名称，需要自然换行.epub','error'),make(3,'Paused.mp4','paused'),make(4,'Downloading.mp4','downloading'),make(5,'Incomplete.zip','incomplete'),make(6,'Waiting.pdf','waiting')]
const requests=[];const sockets=new Set();let failRemoval=true
const server=createServer(socket=>{
 sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=''
 socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){
  const end=buffer.indexOf('\n'),r=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);requests.push(r)
  let reply={ok:true}
  if(r.op==='list') reply.tasks=tasks
  if(r.op==='getSettings') reply.settings={downloadDirectory:root,installerSourceDisposition:'keep',maxConnections:4,maxConcurrentDownloads:4,bandwidthLimitBytesPerSecond:0}
  if(r.op==='fileArtwork') reply.artwork={dataURL:icon,kind:'icon'}
  if(r.op==='remove'||r.op==='removeMany') {
   if(failRemoval) reply={ok:false,error:'fixture removal refused'}
   else {const ids=r.taskIDs??[r.taskID];assert.equal(r.deleteFile,false);assert.ok(ids.every(id=>[1,2].includes(id)));tasks=tasks.filter(t=>!ids.includes(t.id));reply.removed=ids.length}
  }
  socket.write(JSON.stringify({id:r.id,...reply})+'\n')
 }})
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let app
try{
 const executablePath=process.env.NDM_QA_APP_PATH?.trim()
 app=await electron.launch({...(executablePath?{executablePath,args:[`--user-data-dir=${join(root,'electron')}`]}:{args:['.',`--user-data-dir=${join(root,'electron')}`]}),env:{...process.env,NDM_HOST_PORT:String(server.address().port),NDM_SUPPORT_DIR:join(root,'engine'),NDM_BRIDGE_PORT:'0'}})
 const win=await app.firstWindow();await win.waitForLoadState('domcontentloaded');await completeOnboarding(win)
 await win.waitForFunction(async()=>await window.ndm.status()==='live')
 const errors=[];win.on('pageerror',e=>errors.push(e.message))
 await app.evaluate(({shell,ipcMain,clipboard})=>{
  globalThis.fileActions=[]
  // Validate the OS-bound copy payload without changing the user's clipboard.
  globalThis.copiedText=''
  clipboard.writeText=value=>{globalThis.copiedText=value}
  shell.showItemInFolder=path=>globalThis.fileActions.push(['reveal',path])
  ipcMain.removeHandler('system:share-file');ipcMain.handle('system:share-file',(_event,path)=>{globalThis.fileActions.push(['share',path]);return ''})
 })
 await win.locator('[data-task-select="1"]').click()
 const pane=win.locator('#task-inspector')
 assert.equal(await pane.getByText('更多',{exact:true}).count(),0)
 assert.equal(await pane.getByText('完整存储位置',{exact:true}).count(),0)
 assert.equal(await win.locator('#main-sidebar [data-filter="all"]').evaluate(el=>getComputedStyle(el).fontSize),'16px')
 await pane.getByRole('button',{name:'在访达中显示',exact:true}).click()
 await pane.getByRole('button',{name:'分享',exact:true}).click()
 assert.deepEqual(await app.evaluate(()=>globalThis.fileActions),[['reveal',file],['share',file]])
 await pane.locator('[data-detail-field="下载链接"]').getByRole('button',{name:'复制',exact:true}).click()
 assert.equal(await app.evaluate(()=>globalThis.copiedText),tasks[0].url)
 await pane.getByRole('button',{name:'展开下载链接',exact:true}).click()
 assert.equal(await pane.getByRole('button',{name:'收起下载链接',exact:true}).getAttribute('aria-expanded'),'true')
 await pane.getByRole('button',{name:'收起下载链接',exact:true}).click()
 const checks=[]
 for(const width of [280,360,420]){
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,900))
  const before=await pane.boundingBox();const resize=pane.getByRole('separator',{name:'调整任务详情宽度'})
  const box=await resize.boundingBox();await win.mouse.move(box.x+box.width/2,box.y+150);await win.mouse.down();await win.mouse.move(box.x+box.width/2+before.width-width,box.y+150,{steps:8});await win.mouse.up();await win.waitForTimeout(200)
  const bounds=await pane.boundingBox()
  for(const name of ['在访达中显示','分享','删除']) {
   const b=await pane.getByRole('button',{name,exact:true}).boundingBox();assert.ok(b.x>=bounds.x&&b.x+b.width<=bounds.x+bounds.width,`${name} clipped at ${width}`)
   assert.equal(await pane.getByRole('button',{name,exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),true)
  }
  assert.equal(await pane.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
  checks.push({requested:width,actual:bounds.width})
  await win.screenshot({path:join(root,`details-${width}.png`)})
 }
 await win.locator('[data-task-select="2"]').click()
 await pane.getByRole('button',{name:'删除',exact:true}).click()
 await pane.getByRole('button',{name:'取消',exact:true}).click()
 assert.equal(requests.filter(r=>r.op==='remove'||r.op==='removeMany').length,0)
 await win.screenshot({path:join(root,'failed-dark.png')})
 await win.evaluate(()=>document.documentElement.dataset.theme='dawn');await win.waitForTimeout(600)
 await win.screenshot({path:join(root,'failed-dawn.png')})
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(600,500);w.setSize(760,780);w.webContents.setZoomFactor(1.25)})
 await win.waitForTimeout(250)
 await pane.getByRole('button',{name:'删除',exact:true}).click();await pane.getByRole('button',{name:'取消',exact:true}).click()
 assert.equal(await win.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await pane.getByRole('dialog').waitFor({state:'detached'})
 await win.waitForTimeout(250)
 const narrow=await pane.evaluate(el=>{
  const content=el.querySelector('.inspector-content'),field=el.querySelector('.inspector-detail-value');
  return {viewport:innerWidth,pane:el.getBoundingClientRect().toJSON(),parent:el.parentElement.getBoundingClientRect().toJSON(),content:content.getBoundingClientRect().toJSON(),scroll:content.scrollWidth,field:field.getBoundingClientRect().toJSON()}
 })
 console.log('narrow geometry',JSON.stringify(narrow))
 // DevTools screenshots crop to CSS pixels at a non-default page zoom.
 const narrowImage = await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
 writeFileSync(join(root,'narrow-zoom.png'),Buffer.from(narrowImage,'base64'))
 assert.ok(narrow.pane.right<=narrow.viewport+1)
 assert.ok(narrow.scroll<=narrow.content.width+1)

 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setZoomFactor(1);w.setSize(1400,900)})
 await pane.getByRole('button',{name:'关闭任务详情'}).click()
 await win.locator('#main-sidebar').getByRole('button',{name:'设置',exact:true}).click()
 await win.locator('.ndm-settings').getByRole('button',{name:'下载',exact:true}).click()
 await win.getByRole('button',{name:'清除下载记录…',exact:true}).click()
 const dialog=win.getByRole('alertdialog',{name:'清除下载记录',exact:true});await dialog.waitFor()
 assert.equal(await dialog.getByRole('checkbox').count(),2)
 await dialog.getByRole('button',{name:'清除 1 条记录',exact:true}).click()
 await dialog.getByText('未能清除下载记录。请重试。',{exact:true}).waitFor()
 assert.equal(await dialog.getAttribute('aria-busy'),'false')
 assert.equal(tasks.length,6)
 await win.screenshot({path:join(root,'history-failure.png')})
 failRemoval=false
 await dialog.getByRole('checkbox').nth(1).check()
 await dialog.getByRole('button',{name:'清除 2 条记录',exact:true}).click()
 await dialog.getByText('已清除 2 条记录',{exact:true}).waitFor()
 assert.deepEqual(tasks.map(t=>t.id),[3,4,5,6])
 assert.equal(readFileSync(file,'utf8'),'NDM isolated file-action fixture')
 await win.screenshot({path:join(root,'history-cleared.png')})
 await dialog.getByRole('button',{name:'完成',exact:true}).click()
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,root,checks,fileCommands:true,fullURLCopied:true,historyFailureRecoverable:true,pausedAndActivePreserved:true,scope:'real Electron UI with isolated engine and intercepted OS file/clipboard commands'}))
}finally{await app?.close();sockets.forEach(s=>s.destroy());await new Promise(resolve=>server.close(resolve))}
