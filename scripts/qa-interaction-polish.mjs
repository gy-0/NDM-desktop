// Real Electron UI, isolated engine data. Native drag delivery is exercised
// separately with KEEP_OPEN; automated assertions intercept only startDrag.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'
const root = mkdtempSync(join(tmpdir(), 'ndm-interaction-'))
const files = ['拖拽验证 A.txt', '拖拽验证 B.txt'].map(name => join(root, name))
files.forEach((path, index) => writeFileSync(path, `NDM drag fixture ${index}\n`))
const make = (id, filename, status) => ({ id, filename, title: filename, folderPath: root, url: `https://dln1.cdn.ec/books-files/_collection/download/${'example-'.repeat(15)}${id}`, pageURL: 'https://zh.z-library.sk/book/P0vpnzINRr/understanding-border-collies', source: 'zh.z-library.sk', category: 'document', status, fileSize: 1000000, completedBytes: status === 'complete' ? 1000000 : 200000, bytesPerSecond: 0, connections: 4, segments: [], activityAt: Date.now() - id * 1000 })
let tasks = [make(1, '拖拽验证 A.txt', 'complete'), make(2, '拖拽验证 B.txt', 'complete'), make(3, '未完成.txt', 'paused')]
const sockets = new Set()
const server = createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const r = JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1)
      const reply = { id:r.id, ok:true }
      if (r.op === 'list') reply.tasks = tasks
      if (r.op === 'getSettings') reply.settings = { downloadDirectory:root, maxConnections:4, maxConcurrentDownloads:4, smartConnectionsEnabled:false, bandwidthLimitBytesPerSecond:0, bridgePort:51873 }
      if (r.op === 'getBridgeStatus') reply.bridge = {available:true,connectedClients:1,expectedRelayVersion:'2.0.0',relayClients:[{version:'2.0.0',protocol:1,role:'worker'}]}
      socket.write(JSON.stringify(reply)+'\n')
    }
  })
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const executablePath = process.env.NDM_QA_APP_PATH?.trim()
let app
try {
  app=await electron.launch({...(executablePath?{executablePath,args:[`--user-data-dir=${join(root,'electron')}`]}:{args:['.',`--user-data-dir=${join(root,'electron')}`]}),env:{...process.env,NDM_HOST_PORT:String(server.address().port),NDM_SUPPORT_DIR:join(root,'engine'),NDM_BRIDGE_PORT:'0',NDM_DISABLE_LEGACY_BRIDGE:'1'}})
  const win=await app.firstWindow(); await win.waitForLoadState('domcontentloaded'); await completeOnboarding(win)
  await win.waitForFunction(async()=>await window.ndm.status()==='live')
  const issues=[];win.on('pageerror',e=>issues.push(e.message))
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1400,900))
  const capture=async name=> {
    await win.waitForTimeout(200)
    const b64=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    writeFileSync(join(root,`${name}.png`),Buffer.from(b64,'base64'))
  }
  await win.evaluate(()=>{
    document.documentElement.dataset.theme='dawn'
    window.__audioNodes=0
    for(const name of ['createOscillator','createBufferSource']){
      const original=AudioContext.prototype[name]
      AudioContext.prototype[name]=function(...args){window.__audioNodes++; return original.apply(this,args)}
    }
  })
  await win.locator('[data-settings-trigger]').click()
  assert.ok(await win.evaluate(()=>window.__audioNodes)>0,'settings press should produce an audio cue')
  const settings=win.locator('.ndm-settings')
  for(const name of ['通用','外观与声音','下载','网络','浏览器扩展']) assert.equal(await settings.getByRole('button',{name,exact:true}).evaluate(el=>getComputedStyle(el).fontSize),'16px')
  assert.equal(await settings.getByRole('button',{name:'返回应用',exact:true}).evaluate(el=>getComputedStyle(el).fontSize),'16px')
  await settings.getByRole('button',{name:'下载',exact:true}).click()
  for(const name of ['保存与文件','下载性能','下载记录']) assert.equal(await settings.getByText(name,{exact:true}).isVisible(),true)
  assert.equal(await settings.getByText('下载进度样式',{exact:true}).isVisible(),false)
  await win.waitForTimeout(300); await capture('01-settings-downloads')
  await settings.getByRole('button',{name:'外观与声音',exact:true}).click()
  assert.equal(await settings.getByText('下载进度样式',{exact:true}).isVisible(),true)
  await capture('02-settings-appearance')
  await settings.getByRole('button',{name:'浏览器扩展',exact:true}).click()
  assert.equal(await settings.getByText('本机桥接',{exact:true}).count(),0)
  assert.equal(await settings.getByText('NDM Relay',{exact:true}).count(),0)
  const diagnostics=settings.locator('details').filter({hasText:'连接诊断'})
  assert.equal(await diagnostics.getAttribute('open'),null)
  assert.equal(await settings.getByText('登录来源浏览器',{exact:true}).isVisible(),true)
  await capture('03-settings-browser')
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(740,780))
  for (const name of ['外观与声音','下载','网络','浏览器扩展']) {
    await settings.getByRole('button',{name,exact:true}).click()
    assert.equal(await settings.locator('.settings-content').evaluate(el=>el.scrollWidth<=el.clientWidth),true,`${name}: no horizontal overflow`)
  }
  await capture('05-settings-narrow')
  await settings.getByRole('button',{name:'下载',exact:true}).click()
  await settings.locator('.settings-content').evaluate(el=>el.scrollTo({top:el.scrollHeight}))
  await settings.getByRole('button',{name:'外观与声音',exact:true}).click()
  assert.equal(await settings.locator('.settings-content').evaluate(el=>el.scrollTop),0)
  await win.evaluate(()=>document.documentElement.dataset.theme='walnut')
  await capture('06-settings-dark')
  await win.evaluate(()=>document.documentElement.dataset.theme='dawn')
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1400,900))
  await settings.getByRole('button',{name:'返回应用',exact:true}).click()
  const row=id=>win.locator(`[data-task-select="${id}"]`)
  const animation=win.evaluate(()=>new Promise(resolve=>{
    const values=[]; const start=performance.now()
    const tick=()=> {const pane=document.querySelector('#task-inspector');if(pane)values.push({t:performance.now()-start,width:pane.getBoundingClientRect().width});if(performance.now()-start<500)requestAnimationFrame(tick);else resolve(values)};requestAnimationFrame(tick)
  }))
  await row(1).click()
  const widths=await animation
  assert.ok(widths.some(p=>p.width>0&&p.width<280),'pane should reveal below its old minimum width')
  const final=widths.at(-1).width
  const advancing=widths.filter(p=>p.width>10&&p.width<final*.985)
  for(let i=1;i<advancing.length;i++) assert.ok(advancing[i].width>advancing[i-1].width,'pane must not stop before it finishes opening')
  await win.mouse.move(650,40);await win.waitForTimeout(180)
  const actions=row(1).locator('..').locator('[data-row-actions]')
  const title=row(1).locator('[data-task-title]')
  const titleBefore=await title.boundingBox()
  assert.equal(await actions.evaluate(el=>getComputedStyle(el).opacity),'1')
  await row(1).hover();await win.waitForTimeout(180)
  assert.equal(await actions.evaluate(el=>getComputedStyle(el).opacity),'1')
  assert.deepEqual(await title.boundingBox(),titleBefore,'title geometry remains stable on hover')
  await win.mouse.move(650,40);await win.waitForTimeout(180)
  assert.equal(await actions.evaluate(el=>getComputedStyle(el).opacity),'1')
  const selected=await row(1).locator('..').evaluate(el=>({shadow:getComputedStyle(el).boxShadow,image:getComputedStyle(el).backgroundImage}))
  assert.notEqual(selected.shadow,'none'); assert.notEqual(selected.image,'none')
  const source=win.locator('[data-detail-field="来源网页"] .inspector-detail-value span')
  const hostLines=await source.evaluate(el=>{
    const text=el.firstChild;return [...'zh.z-library.sk'].map((_,i)=>{const r=document.createRange();r.setStart(text,i);r.setEnd(text,i+1);return r.getBoundingClientRect().y})
  })
  assert.equal(new Set(hostLines).size,1,'hyphens must not break a hostname that fits')
  await capture('04-selection-and-links')
  await app.evaluate(({BrowserWindow})=>{const wc=BrowserWindow.getAllWindows()[0].webContents;globalThis.nativeStartDrag=wc.startDrag.bind(wc);globalThis.dragCalls=[];wc.startDrag=item=>globalThis.dragCalls.push({files:item.files,iconEmpty:item.icon.isEmpty()})})
  assert.equal(await row(1).getAttribute('draggable'),'true');assert.equal(await row(3).getAttribute('draggable'),'false')
  await row(1).dispatchEvent('dragstart')
  await win.waitForTimeout(100)
  assert.deepEqual((await app.evaluate(()=>globalThis.dragCalls))[0],{files:[files[0]],iconEmpty:false})
  // A native file drag re-enters the renderer as Files, even though its
  // original dragstart was stopped. It must never activate the URL receiver.
  const surface=win.locator('.ndm-workspace')
  const localDrag=await win.evaluateHandle(()=>{
    const transfer=new DataTransfer()
    transfer.items.add(new File(['NDM drag fixture 0\n'],'拖拽验证 A.txt',{type:'text/plain'}))
    transfer.setData('text/uri-list','file:///tmp/ndm-drag-fixture.txt')
    return transfer
  })
  for (const target of [surface,row(1),win.locator('#task-inspector')]) {
    await target.dispatchEvent('dragenter',{dataTransfer:localDrag})
    await target.dispatchEvent('dragover',{dataTransfer:localDrag})
  }
  await capture('07-outbound-drag')
  assert.equal(await win.getByText('请拖入下载链接',{exact:true}).count(),0,'outgoing files must not show the inbound overlay')
  assert.equal(await win.locator('[data-download-drop-target]').count(),0)
  await surface.dispatchEvent('drop',{dataTransfer:localDrag})
  assert.equal(await win.getByText(/本地文件已经在/).count(),0,'dropping back must be a quiet no-op')
  assert.equal(await row(1).getAttribute('aria-pressed'),'true')
  assert.equal(await win.locator('[data-task-select]').count(),3)
  await localDrag.dispose()
  await row(2).click({modifiers:['Meta']}); await row(1).dispatchEvent('dragstart');await win.waitForTimeout(100)
  assert.deepEqual((await app.evaluate(()=>globalThis.dragCalls))[1].files,files)
  await row(2).click();unlinkSync(files[1]);await row(2).dispatchEvent('dragstart')
  await win.locator('[data-preview-notice]').getByText('文件已不在原位置，无法拖出。',{exact:true}).waitFor()
  assert.equal((await app.evaluate(()=>globalThis.dragCalls)).length,2)
  await win.locator('[data-preview-notice]').waitFor({state:'detached',timeout:4500})
  writeFileSync(files[1],'NDM drag fixture 1\n')
  await row(1).click()
  await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].webContents.startDrag=globalThis.nativeStartDrag})
  assert.deepEqual(issues,[])
  writeFileSync('/tmp/ndm-interaction-qa-latest.json',JSON.stringify({root,files,pid:app.process().pid}))
  console.log(JSON.stringify({passed:true,root,settingsSound:true,settingsType:true,persistentRowActions:true,stableHoverTitle:true,hostUnbroken:true,inspectorMotion:true,multiFileDragIPC:true,missingFileNoticeTransient:true,outboundDragLeavesWorkspaceUnchanged:true}))
  if(process.env.NDM_QA_KEEP_OPEN==='1') await new Promise(resolve=>setTimeout(resolve,20*60*1000))
} finally {await app?.close();sockets.forEach(socket=>socket.destroy());await new Promise(resolve=>server.close(resolve))}
