import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('version bump synchronizes lockfile and macOS metadata and increments repeated builds', () => {
  const root = mkdtempSync(join(tmpdir(), 'ndm-version-test-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2020.1.1', buildNumber: '2020010101', build: { mac: { extendInfo: { CFBundleVersion: 'old', CFBundleShortVersionString: 'old' } } } }))
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '2020.1.1', packages: { '': { version: '2020.1.1' } } }))
    let previous
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [resolve('scripts/bump-version.mjs')], { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      const pkg = JSON.parse(readFileSync(join(root, 'package.json')))
      const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')))
      assert.equal(pkg.version, lock.version)
      assert.equal(pkg.version, lock.packages[''].version)
      assert.equal(pkg.build.buildVersion, pkg.buildNumber)
      assert.equal(pkg.build.mac.extendInfo.CFBundleVersion, undefined)
      assert.equal(pkg.build.mac.extendInfo.CFBundleShortVersionString, undefined)
      if (previous) assert.equal(Number(pkg.buildNumber), Number(previous) + 1)
      previous = pkg.buildNumber
    }
  } finally { rmSync(root, { recursive: true }) }
})
