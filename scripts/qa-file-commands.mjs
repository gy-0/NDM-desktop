// Real Electron IPC and installer orchestration, with an isolated fake engine.
// No disk image is mounted and all OS open/reveal operations are intercepted.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { completeOnboarding } from './qa-env.mjs'
const root = mkdtempSync(join(tmpdir(), 'ndm-file-commands-'))
const file = join(root, 'Example.dmg')
const installed = join(root, 'Example.app')
writeFileSync(file, 'isolated QA fixture, never mounted')
mkdirSync(installed)
const task = {id:991,filename:'Example.dmg',title:'Example.dmg',folderPath:root,url:'https://example.test/Example.dmg',source:'example.test',category:'application',status:'complete',fileSize:32,completedBytes:32,bytesPerSecond:0,connections:1,segments:[]}
const iconData = 'data:image/png;base64,' + readFileSync('build/ndm-icon.png').toString('base64')
const requests = []
const sockets = new Set()
const server = createServer(socket => {
  sockets.add(socket); socket.on('close',()=>sockets.delete(socket))
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while(buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1)
      requests.push(request.op)
      const reply = request.op === 'list' ? {tasks:[task]} : request.op === 'getSettings' ? {settings:{installerSourceDisposition:'keep'}} : request.op === 'installDMG' ? {outcome:'installed',installedPath:installed,appName:'Example.app'} : request.op === 'fileArtwork' ? {artwork:{dataURL:iconData,kind:'icon'}} : {}
      socket.write(JSON.stringify({id:request.id,ok:true,...reply})+'\n')
    }
  })
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let app
try {
  app = await electron.launch({args:['.',`--user-data-dir=${join(root,'electron')}`],env:{...process.env,NDM_HOST_PORT:String(server.address().port),NDM_SUPPORT_DIR:join(root,'engine'),NDM_BRIDGE_PORT:'0'}})
  const page = await app.firstWindow()
  await page.getByRole('dialog',{name:'欢迎使用 NDM'}).waitFor()
  await completeOnboarding(page)
  await page.waitForFunction(async()=>await window.ndm.status()==='live')
  await app.evaluate(({shell})=>{
    globalThis.__fileCalls=[]
    shell.openPath=async path=>{globalThis.__fileCalls.push(['open',path]);return ''}
    shell.showItemInFolder=path=>{globalThis.__fileCalls.push(['reveal',path])}
  })
  assert.equal(await page.evaluate(file=>window.ndm.openPath(file),file),'')
  assert.equal(requests.filter(op=>op==='installDMG').length,0)
  assert.equal(await page.evaluate(file=>window.ndm.installDiskImage(file),file),'')
  assert.equal(requests.filter(op=>op==='installDMG').length,1)
  const installedCard = page.locator('[data-testid="install-progress"][data-activity-phase="complete"]')
  await installedCard.waitFor()
  assert.ok(!(await installedCard.innerText()).includes('已保留安装包'))
  for (const theme of ['walnut', 'dawn']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
    await page.waitForTimeout(250)
    assert.equal(await installedCard.getByText('安装完成', {exact:true}).evaluate(el => getComputedStyle(el).fontSize), '18px')
    await page.screenshot({path:join(root, `install-${theme}.png`)})
  }
  console.log('Installation visual evidence:', root)
  assert.deepEqual(await app.evaluate(()=>globalThis.__fileCalls),[['open',file]],'installation must not open Finder or launch the app')
  assert.equal(await page.evaluate(file=>window.ndm.openPath(file),file),'')
  assert.deepEqual(await app.evaluate(()=>globalThis.__fileCalls),[['open',file],['open',file]],'receipt must not redirect the source file')
  await installedCard.getByRole('button',{name:'在访达中显示',exact:true}).click()
  assert.deepEqual((await app.evaluate(()=>globalThis.__fileCalls)).at(-1),['reveal',installed])
  await installedCard.waitFor({state:'hidden'})
  await app.evaluate(()=>globalThis.__fileCalls=[])
  const row = page.locator('[data-task-state="complete"]').filter({hasText:'Example.dmg'})
  await row.hover()
  await row.getByRole('button',{name:'打开磁盘映像（默认应用）',exact:true}).click()
  await page.waitForFunction(()=>globalThis.window.ndm !== undefined)
  assert.equal((await app.evaluate(()=>globalThis.__fileCalls)).at(-1)[1],file)
  await row.locator('[data-task-select]').click()
  await page.locator('#task-inspector').waitFor()
  await row.locator('[data-task-title]').dblclick()
  await row.locator('[data-task-select]').click()
  await page.locator('#task-inspector').getByRole('button',{name:'打开',exact:true}).click()
  await page.waitForTimeout(100)
  const calls = await app.evaluate(()=>globalThis.__fileCalls)
  assert.ok(calls.length===3,JSON.stringify(calls))
  assert.ok(calls.every(([op,path])=>op==='open'&&path===file))
  assert.equal(await page.evaluate(file=>window.ndm.openPath(file),file+'.missing'),'文件不存在')
  console.log('PASS default DMG open, explicit install, installed row/detail/double-click, no automatic Finder, explicit reveal')
} finally {
  await app?.close()
  sockets.forEach(socket=>socket.destroy())
  await new Promise(resolve=>server.close(resolve))
}
