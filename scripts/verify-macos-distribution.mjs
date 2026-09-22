import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Read-only release gate. Local development signing deliberately remains separate.
export function signatureProblems(output) {
  const problems = []
  if (!/^Authority=Developer ID Application: .+$/m.test(output)) problems.push('Developer ID Application signature missing')
  if (!/^TeamIdentifier=[A-Z0-9]{10}$/m.test(output)) problems.push('Apple team identifier missing')
  if (!/^CodeDirectory .*flags=0x[0-9a-f]+\([^\n)]*\bruntime\b[^\n)]*\)/mi.test(output)) problems.push('Hardened Runtime missing')
  if (!/^Timestamp=.+$/m.test(output)) problems.push('Secure timestamp missing')
  if (/^Signature=adhoc$/m.test(output)) problems.push('Ad-hoc signature is not a distribution signature')
  return problems
}

export function verifyDistribution(appPath, run) {
  const checks = []
  const record = (name, passed, detail) => checks.push({ name, passed, ...(detail ? { detail } : {}) })
  const teams = []
  for (const [name, target] of [['App', appPath], ['NDMHost', join(appPath, 'Contents/Resources/bin/NDMHost')]]) {
    const metadata = run('/usr/bin/codesign', ['-d', '--verbose=4', target])
    const problems = metadata.status === 0 ? signatureProblems(metadata.output) : ['Signature metadata unavailable']
    record(`${name} distribution signature`, problems.length === 0, problems.join('; '))
    teams.push(metadata.output.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1])
    const integrity = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target])
    record(`${name} code integrity`, integrity.status === 0)
  }
  record('App and host share an Apple team', Boolean(teams[0]) && teams[0] === teams[1])
  const assessment = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath])
  record('Gatekeeper accepts notarized Developer ID', assessment.status === 0 && /^source=Notarized Developer ID$/m.test(assessment.output))
  const ticket = run('/usr/bin/xcrun', ['stapler', 'validate', appPath])
  record('Stapled notarization ticket', ticket.status === 0)
  return { passed: checks.every(check => check.passed), checks }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') throw new Error('Distribution verification must run on macOS')
  const appPath = resolve(process.argv[2] ?? `dist/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/NDM.app`)
  if (!existsSync(join(appPath, 'Contents/Info.plist'))) throw new Error('Pass an existing packaged NDM.app')
  const result = verifyDistribution(appPath, (command, args) => {
    const child = spawnSync(command, args, { encoding: 'utf8', timeout: 60000, env: { ...process.env, LC_ALL: 'C' } })
    return { status: child.error ? -1 : child.status, output: `${child.stdout ?? ''}\n${child.stderr ?? ''}` }
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.passed) process.exitCode = 1
}
