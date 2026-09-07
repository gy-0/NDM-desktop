import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const app=await electron.launch(qaLaunchOptions('composer-session-retry'))
try {
  const win=await app.firstWindow()
  await win.waitForLoadState('domcontentloaded');await completeOnboarding(win)
  await app.evaluate(({ipcMain})=>{
    globalThis.__retryQA={probes:[],browsers:[],adds:0,mode:'plain'}
    ipcMain.removeHandler('system:classify-url')
    ipcMain.handle('system:classify-url',()=>({kind:'html'}))
    ipcMain.removeHandler('engine:request')
    ipcMain.handle('engine:request',(_e,op,extra)=>{
      if(op==='add') globalThis.__retryQA.adds++
      if(op==='probeMedia') {
        globalThis.__retryQA.probes.push(extra.url)
        globalThis.__retryQA.browsers.push(extra.cookieBrowser ?? null)
        if(globalThis.__retryQA.mode==='chrome' && globalThis.__retryQA.probes.length===1) return {ok:false,errorKind:'browserSessionRequired'}
        if(globalThis.__retryQA.mode==='chrome' && globalThis.__retryQA.probes.length===2) return {ok:false,errorKind:'browserDataUnavailable'}
        if(globalThis.__retryQA.mode==='plain' && globalThis.__retryQA.probes.length===1) return {ok:false,errorKind:'browserDataUnavailable'}
        return {ok:true,title:'Recovered video',formats:[{id:'22',label:'720p',containerHint:'MP4',fileSize:10000,videoCodec:'h264',audioCodec:'aac',height:720}],subtitles:[]}
      }
      return {ok:true,tasks:[]}
    })
  })
  await win.getByRole('button',{name:'添加下载',exact:true}).first().click()
  const input=win.getByPlaceholder(/粘贴下载链接/)
  const url='https://www.bilibili.com/video/BV1retryfixture'
  await input.fill(url)
  await win.locator('#composer-probe-status').filter({hasText:'暂时无法读取浏览器会话'}).waitFor()
  const retry=win.getByRole('button',{name:'重试解析',exact:true})
  assert.equal(await retry.count(),1,'The failure promises a retry but exposes no retry action')
  await win.getByRole('button',{name:'选项',exact:true}).click()
  const filename=win.getByPlaceholder('留空自动识别文件名')
  await filename.fill('My lesson.mp4')
  await retry.click()
  await win.getByText('Recovered video',{exact:true}).waitFor()
  assert.equal(await input.inputValue(),url)
  assert.equal(await filename.inputValue(),'My lesson.mp4')
  assert.equal(await win.locator('#composer-probe-status').count(),0)
  const result=await app.evaluate(()=>globalThis.__retryQA)
  assert.deepEqual(result.probes,[url,url]);assert.equal(result.adds,0)
  await win.getByRole('button',{name:'取消',exact:true}).click()
  await input.waitFor({state:'hidden'})
  await app.evaluate(()=>{globalThis.__retryQA={probes:[],browsers:[],adds:0,mode:'chrome'}})
  await win.getByRole('button',{name:'添加下载',exact:true}).first().click()
  await input.fill(url)
  await win.getByRole('button',{name:'使用 Chrome 会话重试',exact:true}).click()
  await win.locator('#composer-probe-status').filter({hasText:'Chrome 会话暂时无法读取'}).waitFor()
  await retry.click()
  await win.getByText('Recovered video',{exact:true}).waitFor()
  const chromeResult=await app.evaluate(()=>globalThis.__retryQA)
  assert.deepEqual(chromeResult.browsers,[null,'chrome','chrome'],'Retry lost the explicitly chosen browser session')
  assert.equal(chromeResult.adds,0)
  console.log(JSON.stringify({passed:true,retrySameURL:true,inputPreserved:true,errorCleared:true,noDownloadCreated:true,explicitBrowserPreserved:true}))
} finally {await app.close()}
