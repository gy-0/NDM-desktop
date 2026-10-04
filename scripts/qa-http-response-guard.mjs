import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'
const root = mkdtempSync(join(tmpdir(), 'ndm-guard-electron-'))
await build({entryPoints:['scripts/qa-http-response-guard-electron.mjs'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:join(root,'qa.cjs')})
const env = {...process.env}
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron,[join(root,'qa.cjs'),`--user-data-dir=${root}`],{stdio:'inherit',env})
child.on('error',error=>{console.error(error);process.exitCode=1})
child.on('exit',code=>{console.log('REPORT',join(root,'report.json'));process.exitCode=code??1})
