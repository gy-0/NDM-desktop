import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const date = new Date()
const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
const version = parts.join('.')
const prefix = parts.map((n, i) => i === 0 ? String(n) : String(n).padStart(2, '0')).join('')
const previous = String(pkg.buildNumber)
const sequence = previous.startsWith(prefix) ? Number(previous.slice(8)) + 1 : 1
if (!Number.isSafeInteger(sequence) || sequence > 99) throw new Error('Daily build sequence exhausted or invalid')
pkg.version = version
pkg.buildNumber = prefix + String(sequence).padStart(2, '0')
pkg.build ??= {}
pkg.build.buildVersion = pkg.buildNumber
if (pkg.build.mac?.extendInfo) {
  delete pkg.build.mac.extendInfo.CFBundleShortVersionString
  delete pkg.build.mac.extendInfo.CFBundleVersion
}
lock.version = version
lock.packages[''].version = version
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n')
console.log(`NDM ${pkg.version} (${pkg.buildNumber})`)
