import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inspectAuthenticode, verifyAuthenticodeWithSystem } from './windowsSignature.mjs'

const allowUnsigned = process.argv.includes('--allow-unsigned')
const packageJSON = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const requested = process.argv.slice(2).filter((argument) => argument !== '--allow-unsigned')
const paths = requested.length > 0 ? requested : [
  `dist/NDM-Windows-${packageJSON.version}-Setup.exe`,
  'dist/win-unpacked/NDM.exe'
]

let failed = false
for (const input of paths) {
  const path = resolve(input)
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    console.error(`MISSING ${input}: ${error.message}`)
    failed = true
    continue
  }
  const embedded = inspectAuthenticode(bytes)
  if (!embedded.present) {
    const label = allowUnsigned ? 'UNSIGNED QA' : 'UNSIGNED RELEASE BLOCKED'
    console[allowUnsigned ? 'warn' : 'error'](`${label} ${input}: ${embedded.reason}`)
    failed ||= !allowUnsigned
    continue
  }
  const system = verifyAuthenticodeWithSystem(path)
  if (!system.available) {
    const label = allowUnsigned ? 'SIGNATURE PRESENT, CRYPTO CHECK SKIPPED' : 'SIGNATURE CHECK BLOCKED'
    console[allowUnsigned ? 'warn' : 'error'](`${label} ${input}: ${system.detail}`)
    failed ||= !allowUnsigned
    continue
  }
  if (!system.valid) {
    console.error(`INVALID SIGNATURE ${input}: ${system.detail || '系统验证失败'}`)
    failed = true
    continue
  }
  console.log(`VALID AUTHENTICODE ${input}`)
}

if (failed) process.exitCode = 1
