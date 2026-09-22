import test from 'node:test'
import assert from 'node:assert/strict'
import { signatureProblems, verifyDistribution } from '../scripts/verify-macos-distribution.mjs'

const signed = 'Authority=Developer ID Application: Fixture (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\nCodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+0 location=embedded\nTimestamp=Sep 23, 2026 at 03:00:00\n'
const run = (command, args) => ({ status: 0, output: command.endsWith('spctl') ? 'accepted\nsource=Notarized Developer ID\n' : args.includes('-d') ? signed : '' })

test('release gate requires every system check, not just signature metadata', () => {
  assert.equal(verifyDistribution('/fixture/NDM.app', run).passed, true)
  for (const failed of ['codesign', 'spctl', 'xcrun']) {
    assert.equal(verifyDistribution('/fixture/NDM.app', (command, args) => command.endsWith(failed) ? { status: 1, output: '' } : run(command, args)).passed, false)
  }
})
test('development, ad-hoc, missing runtime and untimestamped signatures fail', () => {
  for (const metadata of [signed.replace('Developer ID Application:', 'Apple Development:'), signed.replace('flags=0x10000(runtime)', 'flags=0x0(none)'), signed.replace(/Timestamp=.*\n/, ''), signed.replace(/TeamIdentifier=.*\n/, ''), signed + 'Signature=adhoc\n']) {
    assert(signatureProblems(metadata).length > 0)
  }
})
test('disabled assessments, non-notarized acceptance and mismatched host identity fail closed', () => {
  for (const output of ['assessments disabled', 'accepted\nsource=Developer ID\n']) {
    assert.equal(verifyDistribution('/fixture/NDM.app', (command, args) => command.endsWith('spctl') ? { status: 0, output } : run(command, args)).passed, false)
  }
  assert.equal(verifyDistribution('/fixture/NDM.app', (command, args) => {
    const result = run(command, args)
    return args.includes('-d') && args.at(-1).endsWith('/NDMHost') ? { ...result, output: result.output.replaceAll('ABCDEFGHIJ', 'KLMNOPQRST') } : result
  }).passed, false)
})
