import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OriginalSession } from '../src/main/original/session.ts'
async function fixture(t, authentication = false, finishesBeforePause = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ndm-session-test-'))
  const program = join(directory, 'fixture.cjs')
  await writeFile(program, `
const fs=require('node:fs'),path=require('node:path');
const root=__dirname; let working=true,auth=${authentication},gone=false;
const put=(name,data)=>{fs.writeFileSync(path.join(root,name+'.tmp'),JSON.stringify(data));fs.renameSync(path.join(root,name+'.tmp'),path.join(root,name));};
setInterval(()=>{
 if(fs.existsSync(path.join(root,'release-auth')))auth=false;
 try {const c=JSON.parse(fs.readFileSync(path.join(root,'command.json')));fs.unlinkSync(path.join(root,'command.json'));working=false;gone=${finishesBeforePause};put('command-result.json',{nonce:c.nonce,ok:!gone,settled:!gone,workingAfter:false});}catch(e){if(e.code!=='ENOENT')throw e;}
 put('snapshot.json',{pid:process.pid,time:Date.now()/1000,records:[{id:1,status:working?'1%':'Paused ( 1% )',filename:'a',url:'https://example.test/a',filesize:100,folderpath:''}],tasks:gone?[]:[{id:1,key:'1',working,authenticating:auth,waiting:false}]});
},20);
process.on('SIGTERM',()=>{put('exit.json',{working});process.exit(0);});
`)
  const session = new OriginalSession({ directory, executable: process.execPath, args: [program], startupTimeoutMs: 2000, exitTimeoutMs: 2000 })
  t.after(async () => { if (session.pid) { try { process.kill(session.pid, 'SIGTERM') } catch {} }; await rm(directory, { recursive: true, force: true }) })
  return { directory, session }
}
test('original lifecycle starts once, pauses active work before exit and rejects dead snapshots', async t => {
  const { directory, session } = await fixture(t)
  const a = session.start(), b = session.start()
  assert.equal(a, b)
  await a
  assert.equal(session.status, 'live')
  const competitor = new OriginalSession({ directory, executable: process.execPath, args: ['-e', 'process.exit(0)'] })
  await assert.rejects(competitor.start(), { code: 'EEXIST' })
  assert.equal(competitor.pid, undefined)
  assert.equal((await session.snapshot()).tasks[0].status, 'downloading')
  const stop = session.stop()
  assert.equal(stop, session.stop())
  await stop
  assert.equal(session.status, 'down')
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'exit.json'), 'utf8')), { working: false })
  await assert.rejects(session.snapshot(), /not live/)
})
test('pending authentication retains owned engine until resolved', async t => {
  const { directory, session } = await fixture(t, true)
  await session.start()
  await assert.rejects(session.stop(), /pending interaction/)
  assert.doesNotThrow(() => process.kill(session.pid, 0))
  await assert.rejects(readFile(join(directory, 'exit.json')), { code: 'ENOENT' })
  await writeFile(join(directory, 'release-auth'), '')
  await delay(60)
  await session.stop()
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'exit.json'), 'utf8')), { working: false })
})
test('failed spawn never becomes ready', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ndm-session-missing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const session = new OriginalSession({ directory, executable: join(directory, 'missing'), args: [], startupTimeoutMs: 200 })
  await assert.rejects(session.start(), /ENOENT/)
  assert.equal(session.status, 'down')
  await session.stop()
})

test('stop during startup waits for and settles the owned child', async t => {
  const { session } = await fixture(t)
  const startup = session.start()
  await session.stop()
  await startup
  assert.equal(session.status, 'down')
  assert.throws(() => process.kill(session.pid, 0), { code: 'ESRCH' })
})

test('stopped idle sessions cannot later launch a child', async t => {
  const { session } = await fixture(t)
  await session.stop()
  await assert.rejects(session.start(), /closed/)
  assert.equal(session.pid, undefined)
})

test('task completion racing pause is reconciled from newer worker state', async t => {
  const { session } = await fixture(t, false, true)
  await session.start()
  await session.stop()
  assert.equal(session.status, 'down')
})
