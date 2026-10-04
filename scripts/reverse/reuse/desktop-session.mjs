// QA entry point for the same lifecycle class used by the desktop adapter.
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { OriginalSession } from '../../../src/main/original/session.ts'
let input = ''
for await (const chunk of process.stdin) input += chunk
const options = JSON.parse(input)
const session = new OriginalSession({ ...options, onLog: chunk => process.stdout.write(chunk) })
let stopping = false
process.on('SIGTERM', async () => {
  if (stopping) return
  stopping = true
  try {
    await session.stop()
    await writeFile(join(options.directory, `session-stopped-${process.pid}.json`), JSON.stringify({ wrapperPID: process.pid, enginePID: session.pid, status: session.status }))
    process.exitCode = 0
  } catch (error) { stopping = false; console.error(error) }
})
await session.start()
const ready = join(options.directory, 'session-ready.json')
await writeFile(ready + '.tmp', JSON.stringify({ wrapperPID: process.pid, enginePID: session.pid }))
await rename(ready + '.tmp', ready)
