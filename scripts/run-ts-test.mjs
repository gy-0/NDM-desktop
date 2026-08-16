import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'

const result = await build({
  entryPoints: ['tests/progressGeometry.test.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  external: ['node:assert/strict', 'node:test']
})
const tmp = '/tmp/_pg.test.bundle.mjs'
writeFileSync(tmp, result.outputFiles[0].text)
await import(pathToFileURL(tmp).href)
