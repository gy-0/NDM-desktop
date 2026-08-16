import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { readdirSync, writeFileSync } from 'node:fs'

const entries = readdirSync('tests')
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

for (const [index, entry] of entries.entries()) {
  const result = await build({
    entryPoints: [`tests/${entry}`],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    external: ['node:assert/strict', 'node:test']
  })
  const tmp = `/tmp/ndm-${index}-${entry}`
  writeFileSync(tmp, result.outputFiles[0].text)
  await import(pathToFileURL(tmp).href)
}
