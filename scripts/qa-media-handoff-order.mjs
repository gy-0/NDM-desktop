import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const app = await electron.launch(qaLaunchOptions('media-handoff-order'))
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await completeOnboarding(win)
  await app.evaluate(({ ipcMain }) => {
    globalThis.__handoff = { pending: {}, kinds: {}, adds: [], finishAdd: null }
    ipcMain.removeHandler('system:classify-url')
    ipcMain.handle('system:classify-url', (_e, url) => {
      const q=globalThis.__handoff
      if(q.kinds[url]) return {kind:q.kinds[url]}
      return new Promise(resolve=> {q.pending[url]=resolve})
    })
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request', (_e, op, extra) => {
      if(op==='add') {
        globalThis.__handoff.adds.push(extra.url)
        return new Promise(resolve=> {globalThis.__handoff.finishAdd=()=>resolve({ok:true,task:{id:9200401,url:extra.url,filename:'Independent-binary.bin',status:'paused',fileSize:100,completedBytes:0,segments:[]}})})
      }
      if(op==='probeMedia') return {ok:true,formats:[]}
      return {ok:true,tasks:[]}
    })
  })
  let id=0
  const send=async()=>{
    const url=`https://example.test/media-${++id}`
    await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows()[0].webContents.send('engine:event',{op:'openMediaComposer',url}),url)
    for(let i=0;i<100;i++) {
      if(await app.evaluate((_e,url)=>Boolean(globalThis.__handoff.pending[url]),url)) return url
      await win.waitForTimeout(20)
    }
    throw Error('classification did not arrive')
  }
  const release=(url,kind='html')=>app.evaluate((_e,{url,kind})=>{
    const q=globalThis.__handoff;q.kinds[url]=kind;q.pending[url]({kind});delete q.pending[url]
  },{url,kind})
  const input=win.getByPlaceholder(/粘贴下载链接/)
  const close=async()=>{await win.getByRole('button',{name:'取消',exact:true}).click();await input.waitFor({state:'hidden'})}
  const a=await send(), b=await send()
  await release(b);await input.waitFor();assert.equal(await input.inputValue(),b)
  await release(a);await win.waitForTimeout(180)
  assert.equal(await input.inputValue(),b,'Old classification replaced the latest URL')
  const pending=await send();await close();await release(pending);await win.waitForTimeout(180)
  assert.equal(await input.isVisible(),false,'Closed composer reopened')
  const settingsPending=await send()
  await win.getByRole('button',{name:'设置',exact:true}).first().click()
  await release(settingsPending);await win.waitForTimeout(180)
  assert.equal(await input.isVisible(),false,'Late classification replaced Settings')
  await win.keyboard.press('Escape')
  const manualPending=await send()
  await win.getByRole('button',{name:'添加下载',exact:true}).first().click()
  await input.fill('https://example.test/my-own-input')
  await release(manualPending);await win.waitForTimeout(180)
  assert.equal(await input.inputValue(),'https://example.test/my-own-input','Manual input was overwritten')
  await close()
  const binary=await send();await release(binary,'binary')
  for(let i=0;i<100;i++) {
    if(await app.evaluate(()=>Boolean(globalThis.__handoff.finishAdd))) break
    await win.waitForTimeout(20)
  }
  const latest=await send();await release(latest);await input.waitFor()
  await app.evaluate(()=>globalThis.__handoff.finishAdd())
  await win.waitForTimeout(200)
  assert.equal(await input.inputValue(),latest,'Binary completion stole composer')
  assert.deepEqual(await app.evaluate(()=>globalThis.__handoff.adds),[binary])
  // The independent task was still created, but must not become the selected task.
  await close()
  assert.equal(await win.locator('[data-task-select="9200401"]').getAttribute('aria-pressed'),'false','Old binary completion selected its row')
  // An older classification can still resolve to an independently requested file.
  const lateBinary=await send(), newest=await send()
  await release(newest);await input.waitFor()
  await app.evaluate(()=>{globalThis.__handoff.finishAdd=null})
  await release(lateBinary,'binary')
  for(let i=0;i<100;i++) {
    if(await app.evaluate(()=>Boolean(globalThis.__handoff.finishAdd))) break
    await win.waitForTimeout(20)
  }
  await app.evaluate(()=>globalThis.__handoff.finishAdd())
  await win.waitForTimeout(180)
  assert.equal(await input.inputValue(),newest)
  assert.deepEqual(await app.evaluate(()=>globalThis.__handoff.adds),[binary,lateBinary],'Late independent binary request was lost')
  console.log(JSON.stringify({passed:true,outOfOrder:true,dismiss:true,settings:true,manual:true,binaryPreserved:true}))
} finally {await app.close()}
