// Hold the renderer response and send a second-instance event before first paint.
// Uses an isolated profile and a fake engine; never touches the installed app.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { createServer as createTCPServer } from 'node:net'
import { readFile, mkdtemp } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
const root = await mkdtemp(join(tmpdir(), 'ndm-window-startup-'))
let releaseHTML, releaseJS
const htmlGate = new Promise(resolve => { releaseHTML = resolve })
const jsGate = new Promise(resolve => { releaseJS = resolve })
const web = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path === '/') await htmlGate
  if (path.endsWith('.js')) await jsGate
  try {
    const bytes = await readFile(join(process.cwd(), 'out/renderer', path === '/' ? 'index.html' : path))
    response.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'})[extname(path === '/' ? 'index.html' : path)] ?? 'application/octet-stream')
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
let app
try {
  app = await electron.launch({args:['.', '--mute-audio', `--user-data-dir=${join(root,'profile')}`],env:{...process.env,ELECTRON_RENDERER_URL:`http://127.0.0.1:${web.address().port}/`,NDM_SUPPORT_DIR:join(root,'engine'),NDM_HOST_PORT:String(engine.address().port),NDM_BRIDGE_PORT:'0',NDM_DISABLE_LEGACY_BRIDGE:'1'}})
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
  console.log('early wake checked', result)
  releaseHTML()
  const page = await app.firstWindow()
  await page.getByRole('status').filter({hasText:'正在打开 NDM…'}).waitFor()
  console.log('loading shell visible')
  // Screenshots wait for fonts/load; release the intentionally held module first.
  releaseJS()
  await page.getByRole('button',{name:'添加下载',exact:true}).waitFor()
  assert.equal(await page.getByText('正在打开 NDM…',{exact:true}).count(),0)
  await app.evaluate(({app,BrowserWindow})=>{BrowserWindow.getAllWindows()[0].hide();app.emit('second-instance',{},[],'')})
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true)
  await page.screenshot({path:join(root,'ready.png')})
  console.log(JSON.stringify({passed:true,earlyWake:result,loadingShell:true,reactMounted:true,subsequentWake:true,root}))
} finally {
  releaseHTML();releaseJS()
  await app?.evaluate(({app}) => app.exit(0)).catch(() => undefined)
  for (const socket of sockets) socket.destroy()
  web.closeAllConnections()
  await Promise.all([new Promise(r=>web.close(r)),new Promise(r=>engine.close(r))])
}
