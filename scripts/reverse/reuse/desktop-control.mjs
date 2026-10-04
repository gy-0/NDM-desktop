// Bundle with esbuild before use. Credentials travel over stdin, never argv.
import { readOriginalSnapshot } from '../../../src/main/original/snapshot.ts'
import { OriginalControl } from '../../../src/main/original/control.ts'
let input = ''
for await (const chunk of process.stdin) input += chunk
const { directory, operation, task, credentials, expectedPID } = JSON.parse(input)
const reply = operation === 'snapshot'
  ? await readOriginalSnapshot(directory, expectedPID)
  : await new OriginalControl(directory).request(operation, task, credentials)
process.stdout.write(JSON.stringify(reply))
