// Bundle with esbuild before use. Credentials travel over stdin, never argv.
import { OriginalControl } from '../../../src/main/original/control.ts'
let input = ''
for await (const chunk of process.stdin) input += chunk
const { directory, operation, task, credentials } = JSON.parse(input)
const reply = await new OriginalControl(directory).request(operation, task, credentials)
process.stdout.write(JSON.stringify(reply))
