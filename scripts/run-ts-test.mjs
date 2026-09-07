import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

const entries = readdirSync('tests')
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

// Each run owns its bundles: parallel runs must not overwrite one another,
// and Windows must not depend on a pre-existing /tmp directory.
const directory = mkdtempSync(join(tmpdir(), 'ndm-tests-'))
after(() => rmSync(directory, { recursive: true, force: true }))

for (const entry of entries) {
  const result = await build({
    entryPoints: [`tests/${entry}`],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    external: ['node:assert/strict', 'node:test']
  })
  const tmp = join(directory, entry)
  writeFileSync(tmp, result.outputFiles[0].text)
  await import(pathToFileURL(tmp).href)
}
