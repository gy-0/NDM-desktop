// Actual Windows orchestration + isolated local aria2; can run on macOS, not Windows OS proof.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
const stopAlwaysFails = process.argv.includes('--stop-always-fails')
const removeDuringAdmission = process.argv.includes('--remove-during-admission')
let admissionGid, releaseAdmission
const admissionBarrier=new Promise(resolve=>{releaseAdmission=resolve})
const pauseAllDuringSave = process.argv.includes('--pause-all-during-save')
const pauseDuringSave = process.argv.includes('--pause-during-save') || pauseAllDuringSave
let heldSave = false, releaseSave
const saveBarrier = new Promise(resolve => { releaseSave=resolve })
const singleProbeCancel = process.argv.includes('--single-probe-cancel')
const removeDuringProbe = process.argv.includes('--remove-during-probe')
const pauseAllDuringProbe = process.argv.includes('--pause-all-during-probe')
const pauseDuringProbe = process.argv.includes('--pause-during-probe') || pauseAllDuringProbe || removeDuringProbe
const restartMirror = process.argv.includes('--restart-mirror')
const restartIntentRecovery = process.argv.includes('--restart-intent-recovery')
const allSourcesFail = process.argv.includes('--all-sources-fail')
const primaryHTTPError = process.argv.includes('--primary-http-error')
const removeMirror = process.argv.includes('--remove-mirror')
const deleteOutput = process.argv.includes('--delete-output')
const renewBackup = process.argv.includes('--renew-backup')
const backupResume = process.argv.includes('--backup-resume') || renewBackup
let backupETag = '"backup-v1"'
const pauseBeforeFailover = process.argv.includes('--pause-before-failover')
const lifecycleExperiment = process.argv.includes('--lifecycle-experiment') || pauseBeforeFailover || backupResume || removeMirror || allSourcesFail || primaryHTTPError || restartMirror || restartIntentRecovery || pauseDuringProbe || pauseDuringSave
const freshGenerationExperiment = process.argv.includes('--fresh-generation-experiment')
const root = await mkdtemp(join(tmpdir(), 'ndm-windows-mirror-identity-'))
const downloads = join(root, 'downloads'); await mkdir(downloads)
const payloads = [Buffer.alloc(8 * 1024 * 1024, 0x41), Buffer.alloc(8 * 1024 * 1024, 0x42)]
const changedBackup = Buffer.alloc(8 * 1024 * 1024, 0x43)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const requests = []
const server = createServer(async (req, res) => {
  const primary=req.url.startsWith('/primary'), body=!primary && backupETag==='"backup-v2"' ? changedBackup : payloads[primary?0:1]
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  const start=range?Number(range[1]):0, end=range?.[2]?Math.min(Number(range[2]),body.length-1):body.length-1
  requests.push({path:req.url,method:req.method,range:req.headers.range??null,ifRange:req.headers['if-range']??null})
  if(req.url==='/backup-alias') { res.writeHead(302,{location:'/backup'}); res.end(); return }
  if ((pauseDuringProbe && !primary || singleProbeCancel && primary) && req.headers.range==='bytes=0-0') { await delay(1500); if(res.destroyed) return }
  if (primary && primaryHTTPError) { res.writeHead(403); res.end(); return }
  res.writeHead(range?206:200,{'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(!primary && backupResume ? {ETag:backupETag}:{}),...(range?{'Content-Range':`bytes ${start}-${end}/${body.length}`}:{})})
  let offset=start
  const timer=setInterval(()=>{
    if((primary || allSourcesFail) && offset>=2*1024*1024){clearInterval(timer);res.destroy();return}
    const next=Math.min(offset+65536,end+1);res.write(body.subarray(offset,next));offset=next
    if(offset>end){clearInterval(timer);res.end()}
  },!primary && backupResume ? 24 : 8)
  res.on('close',()=>clearInterval(timer))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
await build({ entryPoints: ['src/main/windows/windowsEngine.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(root, 'engine.mjs') })
await build({ entryPoints: ['src/main/windows/httpRepresentation.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(root, 'representation.mjs') })
const { probeHTTPRepresentation } = await import(pathToFileURL(join(root, 'representation.mjs')))
const { WindowsDownloadEngine } = await import(pathToFileURL(join(root, 'engine.mjs')))
async function freePort() { const s=tcpServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p }
let engine
const report = { root, scope: 'Unvalidated mirrors in Windows task code with local aria2 on '+process.platform, requests, observed: false }
async function boot() {
  let status
  engine = new WindowsDownloadEngine({ experimentalMirrorTransfers: lifecycleExperiment, stateDirectory: join(root,'state'), defaultDownloadDirectory: downloads, aria2Path: process.env.NDM_AUDIT_ARIA2 || '/opt/homebrew/bin/aria2c', ytDlpPath:'/unused', ffmpegPath:'/unused', rpcPort:await freePort() }, {
    onStatus(value) { status=value }, onEvent() {},
    inspectHTTPRepresentation: async (url, headers, proxy, signal) => backupResume || pauseDuringProbe || singleProbeCancel ? probeHTTPRepresentation(url,headers,async request => {
      const response=await fetch(request.url,{headers:request.headers,redirect:'manual',signal:request.signal})
      await response.body?.cancel()
      return {url:response.url,status:response.status,headers:Object.fromEntries(response.headers)}
    },signal) : undefined,
    openHTTPResponse: (url, headers, signal, proxy, request) => { assert.equal(proxy, undefined); return fetch(url,{headers,signal,redirect:'manual',method:request?.method??'GET',...(request ? {body:request.body}: {})}) }
  })
  await engine.start(); assert.equal(status,'live')
  if(removeDuringAdmission) {
    const call=engine.rpc.call.bind(engine.rpc); let failed=false
    engine.rpc.call=async (method,params,signal) => {
      if(method==='forceRemove' && params[0]===admissionGid && (!failed || stopAlwaysFails)) { failed=true; throw new Error('injected stop failure') }
      const reply=await call(method,params,signal)
      if(method==='addUri' && !admissionGid) { admissionGid=reply; await admissionBarrier }
      return reply
    }
  }
  if(pauseDuringSave) {
    const persist=engine.persist.bind(engine)
    engine.persist=async () => {
      await persist()
      if(!heldSave && engine.tasks.some(task=>task.mirrorAttempt?.sourceIndex===1 && task.status==='waiting')) {
        heldSave=true; await saveBarrier
      }
    }
  }
}
async function until(id, predicate) {
  const deadline=Date.now()+20000
  while(Date.now()<deadline) { const task=(await engine.request('list')).tasks.find(t=>t.id===id); if(task && predicate(task)) return task; await delay(50) }
  throw new Error('Task timed out: '+JSON.stringify((await engine.request('list')).tasks))
}
try {
  await boot()
  const base=`http://127.0.0.1:${server.address().port}`
  if(removeDuringAdmission) {
    const added=await engine.request('add',{creationKey:randomUUID(),url:base+'/backup',filename:'admission.bin',folderPath:downloads,autoStart:false})
    const starting=engine.request('resume',{taskID:added.task.id}).then(()=>({rejected:false}),error=>({rejected:true,error:String(error)}))
    const deadline=Date.now()+5000
    while(!admissionGid && Date.now()<deadline) await delay(10)
    assert.ok(admissionGid)
    const removal=engine.request('remove',{taskID:added.task.id,deleteFile:true}).then(()=>({ok:true}),error=>({ok:false,error:String(error)}))
    await delay(40); releaseAdmission()
    const startResult=await starting, removeResult=await removal
    const retained=engine.tasks.find(t=>t.id===added.task.id)
    let status
    try { status=(await engine.rpc.call('tellStatus',[admissionGid])).status } catch { status='absent' }
    report.admissionRemoval={startResult,removeResult,retainedGid:retained?.gid??null,ariaStatus:status}
    if(stopAlwaysFails) {
      assert.equal(removeResult.ok,false)
      assert.equal(retained?.gid,admissionGid)
      assert.ok(['active','waiting'].includes(status))
      assert.equal((await engine.request('list')).tasks.length,1)
      await readFile(join(downloads,'admission.bin'))
    } else {
      assert.ok(!['active','waiting'].includes(status),'Removal must not discard a live writer after stop failure')
      assert.equal(removeResult.ok,true)
      assert.equal((await engine.request('list')).tasks.length,0)
      await assert.rejects(readFile(join(downloads,'admission.bin')),{code:'ENOENT'})
    }
    report.observed=true
  } else if (singleProbeCancel) {
    const added=await engine.request('add',{creationKey:randomUUID(),url:base+'/primary',filename:'single.bin',folderPath:downloads,autoStart:false})
    assert.equal(added.ok,true)
    const starting=engine.request('resume',{taskID:added.task.id}).then(()=>({rejected:false}),error=>({rejected:true,error:String(error)}))
    const deadline=Date.now()+5000
    while(!requests.length && Date.now()<deadline) await delay(10)
    assert.equal(requests[0]?.range,'bytes=0-0')
    const started=Date.now()
    await engine.request(removeDuringProbe ? 'remove' : 'pause',{taskID:added.task.id})
    const elapsedMs=Date.now()-started, startup=await starting
    assert.ok(elapsedMs<600)
    assert.equal(startup.rejected,true)
    await delay(1600)
    assert.equal(requests.length,1)
    const tasks=(await engine.request('list')).tasks
    if(removeDuringProbe) assert.equal(tasks.length,0)
    else assert.equal(tasks[0].status,'paused')
    await assert.rejects(readFile(join(downloads,'single.bin')),{code:'ENOENT'})
    report.singleProbe={operation:removeDuringProbe?'remove':'pause',elapsedMs,startup,status:removeDuringProbe?'removed':'paused',bodyRequests:0}
    report.observed=true
  } else if (freshGenerationExperiment) {
    // Architecture experiment: two engine tasks represent separate source
    // generations. Production must retain one public task and persist selection.
    await build({ entryPoints: ['src/main/windows/mirrorAttempts.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(root, 'attempts.mjs') })
    const { WindowsMirrorAttempts } = await import(pathToFileURL(join(root, 'attempts.mjs')))
    const journalRoot=join(root,'mirror-attempts'), sources=[base+'/primary',base+'/backup']
    const journal=new WindowsMirrorAttempts(journalRoot,1,sources)
    const selected=await journal.current(), firstDirectory=selected.directory
    const first=await engine.request('add',{creationKey:randomUUID(),url:base+'/primary',filename:'payload.bin',folderPath:firstDirectory,connections:8})
    assert.equal(first.ok,true)
    const failed=await until(first.task.id,t=>t.status==='error')
    const previous=await readFile(join(firstDirectory,'payload.bin'))
    assert.ok(previous.length>0)
    const previousHash=sha(previous)
    await engine.stop();engine=undefined;await delay(300);await boot()
    const next=await journal.advance(selected.generation)
    const recovered=await new WindowsMirrorAttempts(journalRoot,1,sources).current()
    assert.deepEqual(recovered,next)
    const secondDirectory=recovered.directory
    const second=await engine.request('add',{creationKey:randomUUID(),url:recovered.url,filename:'payload.bin',folderPath:secondDirectory,connections:8})
    assert.equal(second.ok,true)
    const finished=await until(second.task.id,t=>['complete','error'].includes(t.status))
    assert.equal(finished.status,'complete')
    const staged=join(secondDirectory,'payload.bin'), output=join(downloads,'mirror.bin')
    assert.deepEqual(await readFile(staged),payloads[1])
    assert.equal(sha(await readFile(join(firstDirectory,'payload.bin'))),previousHash)
    const backupRequests=requests.filter(r=>r.path==='/backup')
    assert.ok(backupRequests.length>0)
    assert.ok(!backupRequests[0].range || /^bytes=0-/.test(backupRequests[0].range))
    // Same-volume exclusive publication cannot replace an existing user file.
    const collision=join(downloads,'occupied.bin'), sentinel=Buffer.from('user-owned-file')
    await writeFile(collision,sentinel)
    await assert.rejects(link(staged,collision),{code:'EEXIST'})
    assert.deepEqual(await readFile(collision),sentinel)
    const publisher=new WindowsMirrorAttempts(journalRoot,1,sources)
    await publisher.preparePublication(recovered.generation,output,payloads[1].length)
    await new WindowsMirrorAttempts(journalRoot,1,sources).publish()
    assert.deepEqual(await readFile(output),payloads[1])
    report.freshGeneration={primaryStatus:failed.status,primaryRetainedSHA256:previousHash,backupStatus:finished.status,backupSHA256:sha(await readFile(output)),collisionPreserved:true,engineRelaunched:true,sourceJournalRecovered:true,publicationJournalRecovered:true,firstDirectory,secondDirectory}
    report.scope='Architecture experiment using two isolated Windows engine tasks on '+process.platform+'; not production single-task mirror failover or Windows filesystem proof'
    report.observed=true
  } else {
  const added=await engine.request('add',{creationKey:randomUUID(),url:base+'/primary',mirrors:[base+'/backup'],filename:'mirror.bin',folderPath:downloads,connections:8})
  assert.equal(added.ok,true)
  if(pauseDuringSave) {
    const deadline=Date.now()+10000
    while(!heldSave && Date.now()<deadline) await delay(10)
    assert.ok(heldSave,'Must reach committed source switch before any backup network work')
    const pending=engine.request(pauseAllDuringSave ? 'pauseAll' : 'pause',{taskID:added.task.id})
    await delay(50)
    releaseSave()
    await pending
    await delay(800)
    const backupRequests=requests.filter(r=>r.path==='/backup')
    report.saveBoundaryPause={status:(await engine.request('list')).tasks[0].status,backupRequests}
    assert.equal(report.saveBoundaryPause.status,'paused')
    assert.equal(backupRequests.length,0,'Queued pause must prevent work after the source save settles')
    await engine.request('resume',{taskID:added.task.id})
    await until(added.task.id,t=>t.status==='complete')
    assert.deepEqual(await readFile(join(downloads,'mirror.bin')),payloads[1])
    report.saveBoundaryPause.explicitResumeCompleted=true
  } else if (pauseDuringProbe) {
    const deadline=Date.now()+10000
    while(!requests.some(r=>r.path==='/backup' && r.range==='bytes=0-0') && Date.now()<deadline) await delay(10)
    assert.ok(requests.some(r=>r.path==='/backup' && r.range==='bytes=0-0'))
    const started=Date.now()
    await engine.request(removeDuringProbe ? 'remove' : pauseAllDuringProbe ? 'pauseAll' : 'pause',{taskID:added.task.id})
    report.probePause={elapsedMs:Date.now()-started,status:removeDuringProbe ? 'removed' : (await engine.request('list')).tasks[0].status}
    assert.ok(report.probePause.elapsedMs<600,'Pause must not wait for 1500 ms probe response')
    assert.equal(report.probePause.status,removeDuringProbe ? 'removed' : 'paused')
    await delay(1600)
    assert.ok(!requests.some(r=>r.path==='/backup' && r.range!=='bytes=0-0'))
    if (removeDuringProbe) assert.equal((await engine.request('list')).tasks.length,0)
    else assert.equal((await engine.request('list')).tasks[0].status,'paused')
  } else if (pauseBeforeFailover) {
    const deadline=Date.now()+5000
    while(!requests.some(r=>r.path==='/primary') && Date.now()<deadline) await delay(10)
    assert.ok(requests.some(r=>r.path==='/primary'))
    await delay(40)
    await engine.request('pause',{taskID:added.task.id})
    const record=engine.tasks.find(t=>t.id===added.task.id)
    const partial=join(downloads,`.ndm-mirror-${record.mirrorAttempt.token}`,'attempt-1','payload.bin')
    const bytes=await readFile(partial)
    await delay(700)
    assert.equal((await engine.request('list')).tasks[0].status,'paused')
    assert.ok(!requests.some(r=>r.path==='/backup'))
    assert.deepEqual(await readFile(partial),bytes)
    report.pauseBeforeFailover={status:'paused',backupRequests:0,stableSHA256:sha(bytes),stableMs:700}
    if (restartMirror) {
      const token=record.mirrorAttempt.token
      await engine.request('restart',{taskID:added.task.id})
      await until(added.task.id,t=>t.status==='complete')
      assert.notEqual(engine.tasks.find(t=>t.id===added.task.id).mirrorAttempt.token,token)
      assert.deepEqual(await readFile(join(downloads,'mirror.bin')),payloads[1])
      await assert.rejects(readFile(partial),{code:'ENOENT'})
      report.pausedRestart={sameTaskID:true,newStorageToken:true,oldPartialRemoved:true,finalSHA256:sha(payloads[1])}
    }
    if (removeMirror) {
      await engine.request('remove',{taskID:added.task.id,deleteFile:deleteOutput})
      assert.equal((await engine.request('list')).tasks.length,0)
      await assert.rejects(readFile(partial),{code:'ENOENT'})
      report.pausedRemoval={taskRemoved:true,partialRemoved:true}
    }
  } else {
  if (backupResume) {
    await until(added.task.id,t=>t.status==='downloading' && t.completedBytes>0 && engine.tasks.find(row=>row.id===t.id).mirrorAttempt.sourceIndex===1)
    await engine.request('pause',{taskID:added.task.id})
    const row=engine.tasks.find(t=>t.id===added.task.id)
    const partial=join(downloads,`.ndm-mirror-${row.mirrorAttempt.token}`,'attempt-2','payload.bin')
    const paused=await readFile(partial), sidecar=await readFile(partial+'.aria2')
    await delay(500)
    assert.deepEqual(await readFile(partial),paused)
    assert.deepEqual(await readFile(partial+'.aria2'),sidecar)
    await engine.stop();engine=undefined;await delay(300);await boot()
    backupETag='"backup-v2"'
    const beforeChanged=requests.length
    await assert.rejects(engine.request('resume',{taskID:added.task.id}),/来源|变化|版本/)
    assert.deepEqual(await readFile(partial),paused)
    assert.deepEqual(await readFile(partial+'.aria2'),sidecar)
    const rejectedRequests=requests.slice(beforeChanged)
    assert.equal(rejectedRequests.length,1)
    assert.equal(rejectedRequests[0].path,'/backup')
    assert.equal(rejectedRequests[0].range,'bytes=0-0')
    backupETag='"backup-v1"'
    const before=requests.length
    if (renewBackup) {
      await assert.rejects(engine.request('renew',{taskID:added.task.id,url:base+'/different'}),/来源|变化|版本/)
      assert.deepEqual(await readFile(partial),paused)
      assert.deepEqual(await readFile(partial+'.aria2'),sidecar)
      await engine.request('renew',{taskID:added.task.id,url:base+'/backup-alias'})
    } else await engine.request('resume',{taskID:added.task.id})
    await until(added.task.id,t=>t.status==='complete')
    const resumed=requests.slice(before)
    assert.ok(resumed.every(r=>r.path==='/backup' || renewBackup && ['/backup-alias','/different'].includes(r.path)))
    assert.ok(resumed.some(r=>/^bytes=[1-9]\d*-/.test(r.range??'') && r.ifRange==='"backup-v1"'))
    if(renewBackup) {
      assert.equal((await engine.request('list')).tasks[0].url,base+'/backup-alias')
      report.renewal={differentTargetRejected:true,aliasAccepted:true,payloadRetained:true}
    }
    report.backupResume={pausedBytes:row.completedBytes,stableMs:500,changedValidatorRejected:true,rejectedRequests,partialSHA256:sha(paused),resumedRequests:resumed}
  }
  const terminal=await until(added.task.id,t=>t.status==='complete' || t.status==='error' && (!lifecycleExperiment || engine.tasks.find(row=>row.id===t.id).mirrorAttempt.sourceIndex===1))
  if (allSourcesFail) {
    assert.equal(terminal.status,'error')
    assert.ok(terminal.errorText)
    assert.equal((await engine.request('list')).tasks.length,1)
    await assert.rejects(readFile(join(downloads,'mirror.bin')),{code:'ENOENT'})
    const row=engine.tasks.find(t=>t.id===added.task.id)
    const staging=join(downloads,`.ndm-mirror-${row.mirrorAttempt.token}`)
    const paths=[join(staging,'attempt-1','payload.bin'),join(staging,'attempt-2','payload.bin')]
    const saved=await Promise.all(paths.map(path=>readFile(path)))
    for (let i=0;i<2;i++) { assert.ok(saved[i].length>0); assert.deepEqual(saved[i],payloads[i].subarray(0,saved[i].length)) }
    const count=requests.length
    await delay(1000)
    assert.equal(requests.length,count)
    await engine.stop();engine=undefined;await delay(300);await boot()
    assert.equal((await engine.request('list')).tasks[0].status,'error')
    assert.equal(requests.length,count)
    for (let i=0;i<2;i++) assert.deepEqual(await readFile(paths[i]),saved[i])
    report.exhaustion={status:'error',sourceRequests:count,stableMs:1000,preservedSHA256:saved.map(sha),restoredStatus:'error'}
  } else if (lifecycleExperiment) {
    assert.equal(terminal.status,'complete')
    assert.equal((await engine.request('list')).tasks.length,1)
    const bytes=await readFile(join(downloads,'mirror.bin'))
    assert.deepEqual(bytes,payloads[1])
    const record=engine.tasks.find(t=>t.id===added.task.id)
    assert.equal(record.mirrorAttempt.sourceIndex,1)
    const staging=join(downloads,`.ndm-mirror-${record.mirrorAttempt.token}`)
    const oldBytes=primaryHTTPError ? Buffer.alloc(0) : await readFile(join(staging,'attempt-1','payload.bin'))
    assert.deepEqual(oldBytes,payloads[0].subarray(0,oldBytes.length))
    if (!primaryHTTPError) assert.ok(oldBytes.length>0)
    if (!backupResume) assert.ok(!requests.find(r=>r.path==='/backup').range)
    record.status='paused'; await engine.persist() // Simulate task ledger lagging committed publication.
    const beforeRecovery=requests.length
    await engine.stop();engine=undefined;await delay(300);await boot()
    await engine.request('resume',{taskID:added.task.id})
    assert.equal(requests.length,beforeRecovery)
    const restored=(await engine.request('list')).tasks.find(t=>t.id===added.task.id)
    assert.equal(restored.status,'complete')
    assert.deepEqual(await readFile(join(downloads,'mirror.bin')),payloads[1])
    const recoveryRequestCount=requests.length-beforeRecovery
    if (restartMirror || restartIntentRecovery) {
      const old=engine.tasks.find(t=>t.id===added.task.id), oldToken=old.mirrorAttempt.token
      const beforeRestart=requests.length
      if (restartIntentRecovery) {
        old.mirrorAttempt.restarting=randomUUID().replaceAll('-','')
        old.status='paused'; await engine.persist()
        await engine.stop();engine=undefined;await delay(300);await boot()
        await engine.request('resume',{taskID:added.task.id})
      } else await engine.request('restart',{taskID:added.task.id})
      await until(added.task.id,t=>t.status==='complete')
      const current=engine.tasks.find(t=>t.id===added.task.id)
      assert.notEqual(current.mirrorAttempt.token,oldToken)
      if(renewBackup) {
        assert.equal(current.mirrorAttempt.sources[1],base+'/backup-alias')
        assert.ok(requests.slice(beforeRestart).some(r=>r.path==='/backup-alias'))
      }
      assert.equal((await engine.request('list')).tasks.length,1)
      assert.deepEqual(await readFile(join(downloads,'mirror.bin')),payloads[1])
      await assert.rejects(readFile(join(downloads,`.ndm-mirror-${oldToken}`,'attempts.json')),{code:'ENOENT'})
      report.restart={intentRecovery:restartIntentRecovery,sameTaskID:true,newStorageToken:true,oldStagingRemoved:true,finalSHA256:sha(await readFile(join(downloads,'mirror.bin')))}
    }
    if (removeMirror) {
      await engine.request('remove',{taskID:added.task.id,deleteFile:deleteOutput})
      assert.equal((await engine.request('list')).tasks.length,0)
      await assert.rejects(readFile(join(staging,'attempts.json')),{code:'ENOENT'})
      if (deleteOutput) await assert.rejects(readFile(join(downloads,'mirror.bin')),{code:'ENOENT'})
      else assert.deepEqual(await readFile(join(downloads,'mirror.bin')),payloads[1])
      await engine.stop();engine=undefined;await delay(300);await boot()
      assert.equal((await engine.request('list')).tasks.length,0)
      report.removal={deleteOutput,stagingRemoved:true,taskRemovedAcrossRelaunch:true}
    }
    report.lifecycle={singleTask:true,sourceIndex:1,backupSHA256:sha(bytes),oldBytes:oldBytes.length,restoredStatus:restored.status,recoveryRequests:recoveryRequestCount}
  } else if (process.argv.includes('--expect-guard')) {
    assert.equal(terminal.status,'error'); assert.match(terminal.errorText,/镜像/); assert.equal(requests.length,0)
    await assert.rejects(readFile(join(downloads,'mirror.bin')), {code:'ENOENT'})
    const partial=payloads[0].subarray(0,2*1024*1024), path=join(downloads,'mirror.bin')
    await writeFile(path,partial); await writeFile(path+'.aria2','synthetic-owned-sidecar')
    const record=engine.tasks.find(t=>t.id===added.task.id); record.status='paused';record.completedBytes=partial.length
    await engine.persist();await engine.stop();engine=undefined;await delay(300);await boot()
    for (const op of ['resume','restart']) await assert.rejects(engine.request(op,{taskID:added.task.id}),/镜像地址尚未验证/)
    assert.deepEqual(await readFile(path),partial)
    assert.equal(await readFile(path+'.aria2','utf8'),'synthetic-owned-sidecar')
    assert.equal(requests.length,0)
    report.guardVerified=true;report.preservedPartialSHA256=sha(partial)
  } else {
  const bytes=await readFile(join(downloads,'mirror.bin'))
  report.status=terminal.status; report.errorText=terminal.errorText
  report.bytes=bytes.length;report.sha256=sha(bytes)
  report.matchesPrimary=bytes.equals(payloads[0]);report.matchesBackup=bytes.equals(payloads[1])
  report.mixed=bytes.includes(0x41)&&bytes.includes(0x42)
  report.falseCompletion=terminal.status==='complete'&&!report.matchesPrimary&&!report.matchesBackup
  }
  }
  report.observed=true
  }
} catch(error) { report.error=String(error); process.exitCode=1 }
finally {
  releaseSave(); releaseAdmission()
  if(engine) await engine.stop()
  server.closeAllConnections(); await new Promise(r=>server.close(r))
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
}
