#!/usr/bin/env node
// Theme contrast guard.
//
// Reads the three appearance blocks in src/renderer/src/index.css and
// re-uses the exact luminance/contrast math from tests/themeColorSystem.test.mjs.
// Beyond the assertions the test file locks in, this script also checks the
// brand accent as a foreground and every file-category hue as text on both
// the base and raised surfaces, so a palette change cannot ship an unreadable
// category label.
//
// Run: node scripts/verify-theme-contrast.mjs
// Exits non-zero when any floor is missed.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/renderer/src/index.css', import.meta.url), 'utf8')

function themeBlock(id) {
  const selector = id === 'walnut'
    ? String.raw`:root,\s*\[data-theme='walnut'\]`
    : String.raw`\[data-theme='${id}'\]`
  const match = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`))
  assert.ok(match, `missing ${id} theme block`)
  return match[1]
}

function token(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`))
  assert.ok(match, `missing --${name}`)
  return match[1].trim()
}

function rgb(hex) {
  return Array.from(hex.matchAll(/[0-9a-f]{2}/gi), (match) => Number.parseInt(match[0], 16))
}

function color(value, background) {
  if (value.startsWith('#')) return rgb(value)
  const match = value.match(/rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\)/)
  assert.ok(match, `unsupported color syntax: ${value}`)
  const foreground = match.slice(1, 4).map(Number)
  const alpha = Number(match[4])
  return foreground.map((channel, index) => Math.round(channel * alpha + background[index] * (1 - alpha)))
}

function luminance(channels) {
  const linear = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrast(foreground, background) {
  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background)
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
}

const round2 = (value) => Math.round(value * 100) / 100

const NAMES = { walnut: '墨夜', dawn: '雾昼', noon: '白昼' }
const CATEGORIES = ['video', 'audio', 'document', 'compressed', 'application', 'image', 'misc']

let failed = false
const rows = []

for (const id of Object.keys(NAMES)) {
  const block = themeBlock(id)
  const ink = color(token(block, 'ink'))
  const raised = color(token(block, 'raised'))
  const paper = color(token(block, 'paper'))
  const accent = color(token(block, 'accent'))
  const onAccent = color(token(block, 'on-accent'))
  const accentDeep = color(token(block, 'accent-deep'))

  const checks = [
    // --- the exact assertions themeColorSystem.test.mjs makes ---
    ['paper/ink ≥ 7', contrast(paper, ink), 7],
    ['on-accent/accent ≥ 4.5', contrast(onAccent, accent), 4.5],
    ['fog on ink ≥ 4.5', contrast(color(token(block, 'fog'), ink), ink), 4.5],
    ['mist on ink ≥ 4.5', contrast(color(token(block, 'mist'), ink), ink), 4.5],
    ['fog on raised ≥ 4.5', contrast(color(token(block, 'fog'), raised), raised), 4.5],
    ['mist on raised ≥ 4.5', contrast(color(token(block, 'mist'), raised), raised), 4.5],
    // --- accent used as text / thin marks on both surfaces ---
    ['accent on ink ≥ 4.5', contrast(accent, ink), 4.5],
    ['accent on raised ≥ 4.5', contrast(accent, raised), 4.5],
    ['accent-deep on ink ≥ 3', contrast(accentDeep, ink), 3],
    // --- status hues as small marks ---
    ['ok on ink ≥ 3', contrast(color(token(block, 'ok')), ink), 3],
    ['bad on ink ≥ 3', contrast(color(token(block, 'bad')), ink), 3]
  ]
  // --- category hues appear as category words and icons; both surfaces ---
  for (const category of CATEGORIES) {
    const hue = color(token(block, `cat-${category}`))
    checks.push([`cat-${category} on ink ≥ 4.5`, contrast(hue, ink), 4.5])
    checks.push([`cat-${category} on raised ≥ 4.5`, contrast(hue, raised), 4.5])
  }

  for (const [label, value, min] of checks) {
    const pass = value >= min
    if (!pass) failed = true
    rows.push([`${NAMES[id]} (${id})`, label, round2(value), min, pass])
  }
}

const header = `${'主题'.padEnd(14)} ${'检查'.padEnd(30)} ${'实测'.padEnd(7)} ${'门槛'.padEnd(6)} 结果`
console.log(header)
console.log('-'.repeat(Math.max(header.length, 60)))
for (const [theme, label, value, min, pass] of rows) {
  console.log(
    `${theme.padEnd(14)} ${label.padEnd(30)} ${String(value).padEnd(7)} ${min.toFixed(1).padEnd(6)} ${pass ? 'OK  ' : 'FAIL'}`
  )
}

if (failed) {
  console.error('\nSome theme tokens miss their contrast floor.')
  process.exit(1)
} else {
  console.log('\nAll theme tokens pass every contrast floor.')
}
