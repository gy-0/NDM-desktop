// Real extension in an isolated Chromium profile with an isolated native Host.
// System Chrome: NDM_QA_BROWSER_PATH=<Chrome executable> NDM_QA_LOAD_CDP=1.
// Extension debugging is enabled only for this disposable QA profile.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer as httpServer } from 'node:http'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const root = mkdtempSync(join(tmpdir(), 'ndm-relay-worker-host-')), owned = join(root, 'owned')
const home = join(owned, 'home'), support = join(owned, 'support'), downloads = join(owned, 'downloads')
for (const p of [home, support, downloads]) mkdirSync(p, { recursive: true })
const hostPath = resolve(process.env.NDM_QA_HOST_PATH || 'native/.build/debug/NDMHost')
const bgPath = resolve(process.env.NDM_QA_BACKGROUND || 'extension/NDMRelay/bg.js')
const hash = data => createHash('sha256').update(data).digest('hex')
const payload = Buffer.alloc(1048576); for (let i = 0; i < payload.length; i++) payload[i] = i % 251
const report = { passed: false, root, scope: 'Real Chromium extension, isolated Host and local HTTP; independent profile and ports', hostSHA256: hash(readFileSync(hostPath)), workerSHA256: hash(readFileSync(bgPath)), expectedSHA256: hash(payload) }
let browser, host, hostDone, worker, sequence = 0, socketCount = 0, downloadSendAttempts = 0, requests = 0
const sockets = [], timers = new Set()
const server = httpServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type','text/html'); res.end('<a href="/relay-fixture.zip">Download</a>'); return }
  requests++
  const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/), start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : payload.length - 1
  if (start > end || end >= payload.length) { res.writeHead(416); res.end(); return }
  res.writeHead(match ? 206 : 200, { 'Content-Disposition': 'attachment; filename="relay-fixture.zip"', 'Content-Length': end-start+1, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: '"relay-fixture-v1"', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) })
  if(req.method === 'HEAD') { res.end(); return }
  res.write(payload.subarray(start,Math.min(start+1024,end+1))); const t=setTimeout(()=>res.end(payload.subarray(Math.min(start+1024,end+1),end+1)),350); res.on('close',()=>clearTimeout(t))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
async function freePort() { const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done)); const p = s.address().port; await new Promise(done => s.close(done)); return p }
const port = await freePort(); let bridge = await freePort(); while (bridge === port) bridge = await freePort()
function rpc(op, fields = {}) { return new Promise((done, reject) => {
  const id = ++sequence, s = createConnection({ host: '127.0.0.1', port }); let buffer = '', settled = false
  const finish = (error, reply) => { if (settled) return; settled = true; s.destroy(); error ? reject(error) : done(reply) }
  s.setEncoding('utf8'); s.setTimeout(3000, () => finish(Error('RPC timeout'))); s.on('error', () => finish(Error('RPC failed'))); s.on('close', () => finish(Error('RPC closed')))
  s.on('connect', () => s.write(JSON.stringify({ id, op, ...fields })+'\n'))
  s.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const i=buffer.indexOf('\n'), line=buffer.slice(0,i); buffer=buffer.slice(i+1); try { const r=JSON.parse(line); if(r.id===id)finish(null,r) }catch{finish(Error('RPC JSON'))} } })
}) }
async function until(fn, label, milliseconds = 12000) { const end = Date.now()+milliseconds; while(Date.now()<end) { const value=await fn(); if(value)return value; await delay(50) } throw Error(label) }
try {
  host = spawn(hostPath, [], { cwd: owned, detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: owned, LANG: 'en_US.UTF-8', NDM_SUPPORT_DIR: support, NDM_HOST_PORT: String(port), NDM_BRIDGE_PORT: String(bridge), NDM_DISABLE_LEGACY_BRIDGE: '1' } })
  hostDone = new Promise(done => { host.once('exit',done); host.once('error',done) })
  await until(async () => (await rpc('ping').catch(()=>null))?.ok, 'Host not ready')
  assert.deepEqual((await rpc('list')).tasks, [])
  assert.ok((await rpc('updateSettings', { downloadDirectory: downloads })).ok)
  assert.equal((await rpc('getSettings')).settings.downloadDirectory, downloads)
  const extension = join(owned, 'extension'); cpSync('extension/NDMRelay', extension, {recursive:true});
  const bg = join(extension,'bg.js'); writeFileSync(bg,readFileSync(bg,'utf8').replace(/this.bridgeEndpoints = \[.*?\];/,`this.bridgeEndpoints = ["ws://127.0.0.1:${bridge}/ndm/download"];`));
  browser = await chromium.launchPersistentContext(join(owned,'profile'), {ignoreDefaultArgs:['--disable-extensions'],channel:'chromium',...(process.env.NDM_QA_BROWSER_PATH ? {executablePath:process.env.NDM_QA_BROWSER_PATH} : {}),timeout:20000,headless:true,acceptDownloads:true,args:process.env.NDM_QA_LOAD_CDP === '1' ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  if (process.env.NDM_QA_LOAD_CDP === '1') { const cdp = await browser.browser().newBrowserCDPSession(); const loaded=await cdp.send('Extensions.loadUnpacked',{path:extension}); const popup=await browser.newPage(); await popup.goto(`chrome-extension://${loaded.id}/popup.html`); report.extensionId=loaded.id; }
  worker = browser.serviceWorkers().find(w=>w.url().endsWith('/bg.js')) || await browser.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/bg.js'),timeout:15000});
  await until(()=>worker.evaluate(()=>globalThis.NDM_BG?.bridgeStatus?.durableHandoff===1),'extension-not-connected');
  await worker.evaluate(()=>{
    globalThis.qaEvents=[]; const record=(kind,data)=>qaEvents.push({kind,time:Date.now(),...data});
    chrome.downloads.onCreated.addListener(d=>record('created',{id:d.id}));
    chrome.downloads.onChanged.addListener(d=>record('changed',d));
    chrome.downloads.onErased.addListener(id=>record('erased',{id}));
    const send=NDM_BG.G.send.bind(NDM_BG.G); NDM_BG.G.send=m=>{record(m.startsWith('NDMControl:')?'focus':'send',{});send(m)};
    const receive=NDM_BG.G.onmessage; NDM_BG.G.onmessage=e=>{if(String(e.data).startsWith('NDMRelayReceipt:'))record('receipt',{});receive(e)};
  });
  const page=await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('link',{name:'Download',exact:true}).click();
  const task=await until(async()=>{const rows=(await rpc('list')).tasks;assert.ok(rows.length<=1);return rows[0]?.status==='complete'&&rows[0]},'handoff-not-complete');
  await until(()=>worker.evaluate(()=>qaEvents.some(e=>e.kind==='erased')),'browser-record-not-erased');
  report.events=await worker.evaluate(()=>qaEvents);
  const receipt=report.events.find(e=>e.kind==='receipt'), erased=report.events.find(e=>e.kind==='erased');
  assert.ok(receipt && erased.time>=receipt.time);
  const paused=report.events.find(e=>e.kind==='changed' && e.paused?.current===true);
  assert.ok(paused && paused.time<=receipt.time,'Chrome must pause before the receipt');
  assert.ok(report.events.find(e=>e.kind==='focus').time<=paused.time);
  report.browserHandoffMilliseconds=erased.time-report.events.find(e=>e.kind==='created').time;
  assert.equal(hash(readFileSync(join(task.folderPath,task.filename))),hash(payload));
  assert.equal((await rpc('list')).tasks.length,1);
  report.passed=true;report.bytes=payload.length;
} catch(error) {report.failure=error.message;}
finally {
  if(browser)await Promise.race([browser.close(),delay(5000)]);
  if(host?.pid){try{process.kill(-host.pid,'SIGTERM')}catch{};await Promise.race([hostDone,delay(1000)]);try{process.kill(-host.pid,'SIGKILL')}catch{};await hostDone}
  server.closeAllConnections();await new Promise(done=>server.close(done));
  assert.ok(lstatSync(owned).isDirectory()&&!lstatSync(owned).isSymbolicLink());rmSync(owned,{recursive:true});
  writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
}
