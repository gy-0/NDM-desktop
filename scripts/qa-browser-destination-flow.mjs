// Real Relay wire protocol + isolated Electron/Host + local authenticated HTTP.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const options = qaLaunchOptions('browser-destination-flow')
const root = dirname(options.env.NDM_SUPPORT_DIR), defaults = join(root, 'default'), project = join(root, 'project')
mkdirSync(defaults); mkdirSync(project)
const payload = Buffer.alloc(131072, 57), hash = x => createHash('sha256').update(x).digest('hex')
let requests = 0, app, win, socket
const postBodies = []
const ids = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
  requests++
  if (req.headers.cookie !== 'fixture=authorized') { res.writeHead(403); res.end(); return }
  if (req.method === 'POST') {
    postBodies.push(body)
    if (body !== 'fixture-body=kept') { res.writeHead(400); res.end(); return }
  }
  const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : payload.length - 1
  res.writeHead(match ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': end-start+1, etag:'"destination-fixture"', 'accept-ranges':'bytes', ...(match ? {'content-range':`bytes ${start}-${end}/${payload.length}`} : {}) })
  res.end(req.method === 'HEAD' ? undefined : payload.subarray(start,end+1))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const rpc = (op, args = {}) => win.evaluate(({op,args}) => window.ndm.request(op,args), {op,args})
async function until(fn, message) {
  for (let i=0;i<160;i++) { const value=await fn(); if(value)return value; await new Promise(resolve=>setTimeout(resolve,100)) }
  throw Error(message)
}
async function launch() {
  app = await electron.launch(options); win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded'); await completeOnboarding(win)
  await win.waitForFunction(() => window.ndm.status().then(status=>status==='live'))
  await until(async()=> (await rpc('getSettings').catch(()=>null))?.settings,'Host request channel not ready')
  await app.evaluate(({ipcMain}, path) => { ipcMain.removeHandler('dialog:select-folder'); ipcMain.handle('dialog:select-folder', () => path) }, project)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(920,600))
}
async function send(name, post = false) {
  socket.send(`1:${post ? 'POST' : 'GET'}\r\n2:http://127.0.0.1:${server.address().port}/${name}\r\n3:${name}\r\n6:normal\r\n7:${payload.length}\r\n8:application/octet-stream\r\n10:application/x-www-form-urlencoded\r\nCookie:fixture=authorized\r\n${post ? '__0NeatPostData9__:fixture-body=kept' : ''}`)
}
try {
  await launch()
  assert.equal((await rpc('getSettings')).settings.askBrowserDownloadDestination, false)
  assert.ok((await rpc('updateSettings', {downloadDirectory:defaults,useCategoryFolders:false})).ok)
  await win.getByRole('button',{name:'设置',exact:true}).click()
  await win.getByRole('button',{name:'下载',exact:true}).click()
  await win.getByRole('switch',{name:'浏览器下载前选择保存目录',exact:true}).click()
  await until(async()=> (await rpc('getSettings')).settings.askBrowserDownloadDestination===true,'Settings switch did not persist')
  await win.keyboard.press('Escape')
  socket = new WebSocket(`ws://127.0.0.1:${options.env.NDM_BRIDGE_PORT}/ndm/download`, 'ndm.open.v1')
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject})
  await send('first.bin'); await send('second.bin',true)
  const pending = await until(async()=>{const t=(await rpc('list')).tasks; return t.length===2 && t.every(x=>x.awaitingDestination) ? t : null},'Two captures did not remain pending')
  ids.push(...pending.map(x=>x.id))
  assert.equal(requests,0,'No probe/body before directory confirmation')
  assert.ok(!JSON.stringify(pending).includes('fixture=authorized'),'Snapshot must not expose cookies')
  const dialog = win.getByRole('dialog',{name:'选择保存目录',exact:true})
  await dialog.waitFor()
  for(let i=0;i<12;i++) {
    await win.keyboard.press(i<6?'Tab':'Shift+Tab')
    await win.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    assert.ok(await win.evaluate(()=>Boolean(document.activeElement?.closest('[role="dialog"]'))),'Focus escaped destination dialog')
  }
  await win.screenshot({path:join(root,'pending.png')})
  await win.keyboard.press('Escape')
  await win.waitForTimeout(350)
  assert.equal(requests,0,'Dismiss must not begin downloads')
  assert.equal((await rpc('list')).tasks.filter(x=>x.awaitingDestination).length,2)
  // Restart while both intents are unconfirmed. The database, not a renderer token, owns them.
  socket.close(); await app.close(); app=null
  await launch()
  assert.equal((await rpc('getSettings')).settings.askBrowserDownloadDestination,true)
  await dialogFor().waitFor()
  for (let i=0;i<2;i++) {
    const panel=dialogFor(); await panel.waitFor()
    if (i===0) await panel.getByRole('button',{name:/浏览/}).click()
    await panel.getByRole('button',{name:/确认|开始下载/}).click()
    await until(async()=> (await rpc('list')).tasks.filter(x=>x.status==='complete').length===i+1,'Confirmed capture did not finish')
  }
  const complete=(await rpc('list')).tasks
  assert.ok(postBodies.length>0,'POST body was not forwarded')
  assert.deepEqual(complete.map(x=>x.folderPath).sort(),[defaults,project].sort())
  for(const task of complete) assert.equal(hash(readFileSync(join(task.folderPath,task.filename))),hash(payload))
  const before=requests
  assert.ok((await rpc('confirmDestination',{taskID:complete[0].id,folderPath:root})).ok)
  await win.waitForTimeout(300)
  assert.equal(requests,before,'Duplicate confirmation must not redownload a completed task')
  assert.equal((await rpc('list')).tasks.find(x=>x.id===complete[0].id).folderPath,complete[0].folderPath)
  console.log(JSON.stringify({pendingCount:2,noRequestsBeforeConfirmation:true,recoveredAfterRelaunch:true,authenticatedFiles:2,postBodyPreserved:true,sha256:hash(payload),duplicateSafe:true,screenshot:join(root,'pending.png')}))
} finally {
  if(win && app) for(const taskID of ids) await rpc('remove',{taskID,deleteFile:true}).catch(()=>{})
  socket?.close(); await app?.close().catch(()=>{})
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve))
}
function dialogFor(){return win.getByRole('dialog',{name:'选择保存目录',exact:true})}
