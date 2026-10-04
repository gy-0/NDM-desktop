// Hold the renderer response and send a second-instance event before first paint.
// Uses an isolated profile and a fake engine; never touches the installed app.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { createServer as createTCPServer } from 'node:net'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isolateQAClipboard, completeOnboarding } from './qa-env.mjs'
import { join, extname, resolve, dirname } from 'node:path'
import { extractFile } from '@electron/asar'
import { tmpdir } from 'node:os'
const root = await mkdtemp(join(tmpdir(), 'ndm-window-startup-'))
const packagedExecutable = process.env.NDM_QA_APP_PATH?.trim()
const archive = packagedExecutable ? resolve(dirname(packagedExecutable), '../Resources/app.asar') : null
let releaseHTML, releaseJS
const htmlGate = new Promise(resolve => { releaseHTML = resolve })
const jsGate = new Promise(resolve => { releaseJS = resolve })
const web = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path === '/') {
    // Commit the document so Playwright can attach before its body arrives.
    if (!response.headersSent) response.setHeader('Content-Type', 'text/html')
    response.flushHeaders()
    await htmlGate
  }
  if (path.endsWith('.js')) await jsGate
  try {
    const asset = path === '/' ? 'index.html' : path.slice(1)
    const bytes = archive ? extractFile(archive, 'out/renderer/' + asset) : await readFile(join(process.cwd(), 'out/renderer', asset))
    if (!response.headersSent) response.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'})[extname(path === '/' ? 'index.html' : path)] ?? 'application/octet-stream')
    response.end(bytes)
  } catch { response.writeHead(404).end() }
})
const sockets = new Set()
const engine = createTCPServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket))
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), req = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1)
      socket.write(JSON.stringify({id:req.id,ok:true,tasks:[],settings:{downloadDirectory:root},bridge:{available:true,connectedClients:0}})+'\n')
    }
  })
})
await Promise.all([new Promise(r => web.listen(0,'127.0.0.1',r)),new Promise(r => engine.listen(0,'127.0.0.1',r))])
const report = { root, passed: false, packagedExecutable: packagedExecutable ?? null }
let app
try {
  app = await electron.launch({...(packagedExecutable ? { executablePath: packagedExecutable } : {}),args:[...(packagedExecutable ? [] : ['.']), '--mute-audio', `--user-data-dir=${join(root,'profile')}`],env:{...process.env,ELECTRON_RENDERER_URL:`http://127.0.0.1:${web.address().port}/`,NDM_SUPPORT_DIR:join(root,'engine'),NDM_HOST_PORT:String(engine.address().port),NDM_BRIDGE_PORT:'0',NDM_DISABLE_LEGACY_BRIDGE:'1'}})
  app.context().setDefaultTimeout(15000)
  await isolateQAClipboard(app)
  report.app = await app.evaluate(({app}) => ({ packaged: app.isPackaged, path: app.getAppPath(), version: app.getVersion() }))
  if (packagedExecutable) {
    assert.equal(report.app.packaged, true)
    report.app.asarSHA256 = createHash('sha256').update(await readFile(report.app.path)).digest('hex')
  }
  await app.evaluate(async ({app,BrowserWindow}) => {
    if (!BrowserWindow.getAllWindows().length) await new Promise(resolve => app.once('browser-window-created', resolve))
  })
  const result = await app.evaluate(({app,BrowserWindow}) => {
    const w = BrowserWindow.getAllWindows()[0]
    const before = w.isVisible()
    app.emit('second-instance', {}, [], '')
    return {before,after:w.isVisible()}
  })
  assert.deepEqual(result,{before:false,after:false})
  report.earlyWake = result
  releaseHTML()
  const page = await app.firstWindow({ timeout: 15000 })
  await page.getByRole('status').filter({hasText:'正在打开 NDM…'}).waitFor()
  report.loadingShell = true
  report.heldModuleWindow = await app.evaluate(async ({app,BrowserWindow}) => {
    const w = BrowserWindow.getAllWindows()[0], start = Date.now()
    while (!w.isVisible() && Date.now() - start < 2000) await new Promise(resolve => setTimeout(resolve, 25))
    const beforeWake = w.isVisible()
    app.emit('second-instance', {}, [], '')
    return { beforeWake, afterWake: w.isVisible(), observedForMS: Date.now() - start }
  })
  // Capture through WebContents: Playwright screenshots wait for the module/load
  // being deliberately held here. Do not release it just to obtain the image.
  const shell = await app.evaluate(async ({BrowserWindow}) => {
    const w = BrowserWindow.getAllWindows()[0]
    const image = await w.webContents.capturePage()
    return { visible: w.isVisible(), png: image.toPNG().toString('base64') }
  })
  report.shellWindowVisible = shell.visible
  await writeFile(join(root,'loading-shell.png'), Buffer.from(shell.png, 'base64'))
  // Resume the real bundled module only after observing the held-module state.
  releaseJS()
  await page.getByRole('dialog',{name:'欢迎使用 NDM'}).waitFor()
  await completeOnboarding(page)
  await page.locator('#main-sidebar').getByRole('button',{name:'添加下载',exact:true}).waitFor()
  assert.equal(await page.getByText('正在打开 NDM…',{exact:true}).count(),0)
  await app.evaluate(({app,BrowserWindow})=>{BrowserWindow.getAllWindows()[0].hide();app.emit('second-instance',{},[],'')})
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true)
  await page.screenshot({path:join(root,'ready.png')})
  Object.assign(report, { passed:true, reactMounted:true, subsequentWake:true })
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  releaseHTML();releaseJS()
  await app?.evaluate(({app}) => app.exit(0)).catch(() => undefined)
  for (const socket of sockets) socket.destroy()
  web.closeAllConnections()
  await Promise.all([new Promise(r=>web.close(r)),new Promise(r=>engine.close(r))])
  await writeFile(join(root,'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
