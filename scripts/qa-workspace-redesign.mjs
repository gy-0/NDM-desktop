import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qaLaunchOptions, completeOnboarding } from './qa-env.mjs'
const root=await mkdtemp(join(tmpdir(),'ndm-design-'))
const app=await electron.launch(qaLaunchOptions('workspace-redesign'))
let hostErrors = ''
app.process().stderr.on('data',chunk=>{hostErrors += chunk.toString()})
try {
 const win=await app.firstWindow(); await win.waitForLoadState('domcontentloaded'); await completeOnboarding(win)
 await win.waitForFunction(async()=>await window.ndm.status()==='live')
 await win.waitForFunction(async()=>Array.isArray((await window.ndm.request('list')).tasks))
 await win.waitForTimeout(500)
 const tasks=Array.from({length:3684},(_,i)=>({id:i+1,filename:i===0?'manifest-audio_0_abcdefghijklmnopqrstuvwxyz.webm':`设计资料与项目文件 ${i+1} — 完整的长文件名称示例.pdf`,title:i===0?'城市交通的下一章：自动驾驶设计观察':`设计资料 ${i+1}`,url:`https://example.invalid/file-${i}.pdf`,source:'example.invalid',category:'document',status:i===0?'error':i%5===0?'downloading':i%3===0?'paused':'complete',fileSize:i===0?0:24000000,completedBytes:i%5===0?12000000:24000000,bytesPerSecond:i%5===0?204800:0,connections:4,activityAt:Date.now()-i*1000,folderPath:root,errorText:i===0?'expired':undefined,diagnostic:i===0?{title:'下载链接已失效',message:'请更新下载链接后重试。',summary:'链接已失效',primaryAction:'renew'}:undefined}))
 await app.evaluate(({BrowserWindow},tasks)=>BrowserWindow.getAllWindows()[0].webContents.send('engine:event',{op:'snapshot',tasks}),tasks)
 await win.locator('[data-task-select="1"]').waitFor()
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(500,500);w.setSize(1500,900)})
 await win.locator('[data-task-select="1"]').click()
 const pane=win.locator('#task-inspector')
 await pane.getByRole('button',{name:'更新下载链接…',exact:true}).click()
 await pane.getByRole('textbox',{name:'新的下载链接'}).fill('https://example.invalid/new-file.pdf')
 const checks=[]
 for(const width of [1500,1220,1040,760,600,1500]) {
  await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width)
  await win.waitForTimeout(240)
  assert.equal(await pane.getByRole('textbox',{name:'新的下载链接'}).inputValue(),'https://example.invalid/new-file.pdf')
  const sample=await win.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,overlay:document.querySelector('#task-inspector').hasAttribute('data-overlay'),selected:document.querySelector('[data-task-select="1"]').getAttribute('aria-pressed'),rows:document.querySelectorAll('[data-task-select]').length,filenameWidth:document.querySelector('.task-table-row > span').getBoundingClientRect().width}))
  assert.equal(sample.overflow,false);assert.equal(sample.selected,'true');assert.ok(sample.rows<80);checks.push(sample)
  if([1500,1040,600].includes(width)) await win.screenshot({path:join(root,`workspace-${width}.png`)})
 }
 assert.equal(checks[0].overlay,false);assert.equal(checks[2].overlay,true)
 await pane.getByRole('button',{name:'关闭任务详情'}).click()
 assert.equal(await win.locator('[data-task-select="1"]').getAttribute('aria-pressed'),'true')
 await win.getByRole('button',{name:'切换任务详情'}).click();await pane.waitFor()
 assert.equal(await pane.locator('h2').innerText(),'城市交通的下一章：自动驾驶设计观察')
 assert.ok(!(await pane.getByLabel('任务概要').innerText()).includes('计算中'))
 await pane.getByRole('button',{name:'关闭任务详情'}).click()
 await win.screenshot({path:join(root,'library.png')})
 await win.evaluate(()=>{document.documentElement.dataset.theme='dawn'})
 await win.screenshot({path:join(root,'library-dawn.png')})
 await win.getByRole('button',{name:'切换任务详情'}).click()
 const scroller=win.locator('.task-table section')
 await scroller.evaluate(el=>{el.scrollTop=20000})
 const scrollBefore=await scroller.evaluate(el=>el.scrollTop)
 await pane.getByRole('button',{name:'关闭任务详情'}).click()
 assert.equal(await scroller.evaluate(el=>el.scrollTop),scrollBefore)
 await win.getByRole('button',{name:'切换任务详情'}).click()
 assert.equal(await scroller.evaluate(el=>el.scrollTop),scrollBefore)
 await pane.getByRole('button',{name:'关闭任务详情'}).click()
 await win.locator('#main-sidebar').getByRole('button',{name:/下载中/}).click()
 await win.waitForTimeout(200)
 assert.equal(await win.locator('.task-table-header').getByText('速度',{exact:true}).count(),1)
 await win.screenshot({path:join(root,'active-dawn.png')})
 console.log(JSON.stringify({passed:true,hostErrors:hostErrors.slice(-1200),scope:'3684 synthetic tasks in the real Electron renderer; isolated host',root,checks}))
} finally {await app.close()}
