// QA entry point for the same lifecycle class used by the desktop adapter.
import { writeFile, rename, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { OriginalIntake } from '../../../src/main/original/intake.ts'
import { readOriginalState } from '../../../src/main/original/snapshot.ts'
import { OriginalSession } from '../../../src/main/original/session.ts'
let input = ''
for await (const chunk of process.stdin) input += chunk
const options = JSON.parse(input)
const session = new OriginalSession({ ...options, onLog: chunk => process.stdout.write(chunk) })
let stopping = false
let intake, intakeTimer
let intakeWork = Promise.resolve()
process.on('SIGTERM', async () => {
  if (stopping) return
  stopping = true
  try {
    clearInterval(intakeTimer)
    await intakeWork
    await intake?.close()
    await session.stop()
    await writeFile(join(options.directory, `session-stopped-${process.pid}.json`), JSON.stringify({ wrapperPID: process.pid, enginePID: session.pid, status: session.status }))
    process.exitCode = 0
  } catch (error) { stopping = false; console.error(error) }
})
await session.start()
const ready = join(options.directory, 'session-ready.json')
await writeFile(ready + '.tmp', JSON.stringify({ wrapperPID: process.pid, enginePID: session.pid }))
await rename(ready + '.tmp', ready)

intake = new OriginalIntake(options.directory, options.bridgePort, async () => (await readOriginalState(options.directory, session.pid)).records)
let busy = false
intakeTimer = setInterval(() => {
  if (busy || stopping) return
  busy = true
  intakeWork = (async () => {
    let request
    try { request = JSON.parse(await readFile(join(options.directory, 'submission.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    await unlink(join(options.directory, 'submission.json'))
    let reply
    try { reply = { nonce: request.nonce, ok: true, taskID: await intake.submit(request.submission) } }
    catch (error) { reply = { nonce: request.nonce, ok: false, error: error.message } }
    const target = join(options.directory, 'submission-result.json')
    await writeFile(target + '.tmp', JSON.stringify(reply))
    await rename(target + '.tmp', target)
  })().catch(error => console.error(error)).finally(() => { busy = false })
}, 50)
