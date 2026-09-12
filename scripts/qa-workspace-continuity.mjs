// Isolated, synthetic workspace evidence. No production library or remote URLs.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completeOnboarding } from './qa-env.mjs'

const root = mkdtempSync(join(tmpdir(), 'ndm-workspace-cycle-'))
const now = Date.now()
const make = (id, filename, category, status, progress = 0) => ({
  id, filename, title: filename, category, status, folderPath: root,
  url: `https://example.com/downloads/${encodeURIComponent(filename)}`, source: 'example.com',
  pageURL: 'https://example.com/resources', fileSize: 280 * 1024 * 1024,
  completedBytes: Math.round(progress * 280 * 1024 * 1024),
  bytesPerSecond: status === 'downloading' ? (id === 1 ? 14 : 4) * 1024 * 1024 : 0,
  connections: 8, segments: [], activityAt: now - id * 120000,
  ...(status === 'error' ? { errorMessage: 'The connection timed out.', diagnostic: { summary: '连接超时', detail: '服务器暂时没有响应，请重试。', code: 'network_timeout' } } : {})
})
let tasks = [make(1, 'Nord — Brand system.zip', 'compressed', 'downloading', .42), make(2, 'Field Notes — Autumn Collection.pdf', 'document', 'complete', 1),
  make(3, 'Studio textures.zip', 'compressed', 'paused', .72), make(4, 'Interface studies.mp4', 'video', 'downloading', .26),
  make(5, 'Typography specimen.pdf', 'document', 'error'), make(6, 'Ambient recordings.flac', 'audio', 'waiting'),
  ...Array.from({length:70}, (_, i) => make(i + 7, `Design reference ${String(i + 1).padStart(2, '0')}.pdf`, 'document', 'complete', 1))]
const operations = []
const sockets = new Set()
const server = createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      operations.push({op:request.op, taskID:request.taskID})
      const reply = {id:request.id, ok:true}
      if (request.op === 'list') reply.tasks = tasks
      if (request.op === 'getSettings') reply.settings = {downloadDirectory:root,maxConnections:8,maxConcurrentDownloads:4,bandwidthLimitBytesPerSecond:0,bridgePort:0}
      if (request.op === 'getBridgeStatus') reply.bridge = {available:true,connectedClients:0,expectedRelayVersion:'2.0.0',relayClients:[]}
      socket.write(JSON.stringify(reply)+'\n')
    }
  })
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
let app
const evidence = []
try {
  const executablePath = process.env.NDM_QA_APP_PATH?.trim()
  app = await electron.launch({...(executablePath?{executablePath,args:[`--user-data-dir=${join(root,'electron')}`]}:{args:['.',`--user-data-dir=${join(root,'electron')}`]}),env:{...process.env,NDM_SUPPORT_DIR:join(root,'engine'),NDM_HOST_PORT:String(server.address().port),NDM_BRIDGE_PORT:'0',NDM_DISABLE_LEGACY_BRIDGE:'1'}})
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded'); await completeOnboarding(win)
  await win.waitForFunction(async()=>await window.ndm.status()==='live')
  const errors=[];win.on('pageerror',e=>errors.push(e.message))
  const resize=async(width,height)=>{await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);await win.waitForTimeout(300)}
  const capture=async(name)=>{
    await win.mouse.move(400,15);await win.waitForTimeout(250)
    const shot=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    writeFileSync(join(root,`${name}.png`),Buffer.from(shot,'base64'))
    evidence.push({name,...await win.evaluate(()=>{
      const box=s=>{const el=document.querySelector(s);if(!el)return null;const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,overflow:el.scrollWidth>el.clientWidth,text:el.innerText?.slice(0,180)}}
      return{title:box('.library-heading'),toolbar:box('.library-toolbar'),actions:box('.library-actions'),list:box('.task-table'),hero:box('[data-hero-state]'),inspector:box('#task-inspector'),scrollTop:document.querySelector('.task-table section')?.scrollTop,firstRow:box('[data-task-select]'),window:{width:innerWidth,height:innerHeight}}
    })})
  }
  await resize(1440,900)
  await capture('01-dark-all')
  await win.locator('[data-task-select="2"]').click();await capture('02-dark-complete-selected')
  const card = win.locator('[data-completed-file-card]')
  const cardBefore = await card.boundingBox()
  await card.getByRole('button', {name:'预览', exact:true}).click()
  await card.locator('[data-file-delivery-notice]').waitFor()
  assert.match(await card.locator('[data-file-delivery-notice]').innerText(), /找不到文件/)
  assert.equal((await card.boundingBox()).height, cardBefore.height, 'preview notice changed card height')
  await capture('02b-preview-feedback')
  await card.locator('[data-file-delivery-notice]').waitFor({state:'hidden', timeout:4500})
  await win.locator('[data-task-select="2"]').hover()
  await win.locator('[data-task-select="2"]').locator('..').getByRole('button', {name:'快速预览 (Space)', exact:true}).click()
  await win.locator('[data-preview-notice]').waitFor()
  assert.match(await win.locator('[data-preview-notice]').innerText(), /找不到文件/)
  await win.locator('[data-preview-notice]').waitFor({state:'hidden', timeout:4500})
  await win.locator('[data-task-select="2"]').focus()
  await win.keyboard.press('Enter')
  await win.locator('[data-preview-notice]').waitFor()
  assert.match(await win.locator('[data-preview-notice]').innerText(), /打开文件/)
  // Delay one isolated system response, then change selection. The previous
  // file must not leave a notice over the newly selected file.
  await win.locator('[data-preview-notice]').waitFor({state:'hidden', timeout:4500})
  await app.evaluate(({ipcMain}) => {
    ipcMain.removeHandler('system:quick-look')
    ipcMain.handle('system:quick-look', () => new Promise(resolve => setTimeout(() => resolve(false), 900)))
  })
  await win.locator('[data-task-select="2"]').hover()
  await win.locator('[data-task-select="2"]').locator('..').getByRole('button', {name:'快速预览 (Space)', exact:true}).click()
  await win.locator('[data-task-select="3"]').click()
  await win.waitForTimeout(1200)
  assert.equal(await win.locator('[data-preview-notice]').count(), 0, 'late preview response followed the next file')

  await win.locator('[data-filter="active"]').click();await capture('03-dark-active')
  await resize(1000,740);await capture('04-dark-active-narrow')
  await win.locator('[data-filter="failed"]').click();await capture('05-dark-failed')
  await win.locator('[data-filter="all"]').click()
  await win.locator('#ndm-search').fill('not-found');await capture('06-search-empty')
  await win.locator('#ndm-search').fill('');await resize(1440,900)
  await win.locator('[data-task-select="2"]').click();await capture('06b-before-multiselect')
  await win.locator('[data-task-select="3"]').click({modifiers:['Meta']});await capture('07-multiselect')
  assert.equal(evidence.at(-1).list.y, evidence.at(-2).list.y, 'selection toolbar shifted the file list')
  await win.locator('[data-filter="all"]').click()
  await win.evaluate(()=>document.documentElement.dataset.theme='dawn');await capture('08-dawn-all')
  await resize(740,640);await capture('09-dawn-small')
  await win.evaluate(()=>document.documentElement.dataset.theme='noon');await capture('10-noon-small')
  writeFileSync(join(root,'evidence.json'),JSON.stringify({evidence,errors,operations},null,2))
  console.log(JSON.stringify({root,evidenceCount:evidence.length,errors}))
}finally{await app?.close();for(const socket of sockets)socket.destroy();server.close()}
