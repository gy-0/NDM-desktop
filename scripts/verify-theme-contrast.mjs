#!/usr/bin/env node
// Theme contrast guard for the copper (warm-teak) accent candidates.
//
// Re-uses the exact luminance/contrast math from tests/themeColorSystem.test.mjs
// (WCAG relative luminance, sRGB gamma decode) and asserts the same thresholds
// the test file locks in, but evaluated against the *candidate* warm-teak
// accent + on-accent combinations proposed for each appearance.
//
// Run: node scripts/verify-theme-contrast.mjs
// Exits non-zero if any candidate fails a threshold the test file would assert
// on it, so it can gate a future enable of the teak accent.

import assert from 'node:assert/strict'

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

function round2(value) {
  return Math.round(value * 100) / 100
}

// Candidate boards.
//
// `accent` / `onAccent` are the proposed warm-teak swap; `ink`, `raised`,
// `fog`, `mist`, `paper` are the current shipped tokens they must play
// against unchanged. `teakFg` is the accent-anchored foreground that copper
// surfaces need (--copper on --paper/--ink across surfaces), kept separate
// so the script also catches the "shallow theme can't ship copper as its own
// ink" trap without locking the theme test.
const themes = {
  walnut: {
    name: '墨夜',
    ink: '#111113',
    raised: '#222225',
    fog: 'rgb(250 250 250 / 0.8)',
    mist: 'rgb(250 250 250 / 0.54)',
    paper: '#fafafa',
    accent: '#b0885c',
    onAccent: '#22160e',
    accentDeep: '#a97a52',
    ok: '#72b98b',
    bad: '#e87872',
    teakFg: '#b0885c',
    // copper surfaces commonly sit on raised (chips) or ink; check both.
    teakFgSurfaces: ['#222225', '#111113']
  },
  dawn: {
    name: '雾昼',
    ink: '#f7f7f8',
    raised: '#ffffff',
    fog: 'rgb(24 24 27 / 0.74)',
    mist: 'rgb(24 24 27 / 0.62)',
    paper: '#1c1c1f',
    accent: '#a97a52',
    onAccent: '#1c110a',
    accentDeep: '#8a5e3a',
    ok: '#3f7656',
    bad: '#ad4d48',
    teakFg: '#8a5e3a', // shallow themes must pair copper *ink* with a deep copper fg
    teakFgSurfaces: ['#f7f7f8', '#ffffff']
  },
  noon: {
    name: '白昼',
    ink: '#ffffff',
    raised: '#ffffff',
    fog: 'rgb(24 24 27 / 0.72)',
    mist: 'rgb(24 24 27 / 0.62)',
    paper: '#18181b',
    accent: '#a97a52',
    onAccent: '#1c110a',
    accentDeep: '#8a5e3a',
    ok: '#397451',
    bad: '#a94440',
    teakFg: '#8a5e3a',
    teakFgSurfaces: ['#ffffff', '#ffffff']
  }
}

let failed = false
const rows = []

for (const [id, t] of Object.entries(themes)) {
  const inkC = color(t.ink)
  const paperC = color(t.paper)
  const raisedC = color(t.raised)
  const accentC = color(t.accent)
  const onAccentC = color(t.onAccent)
  const teakFgC = color(t.teakFg)

  const checks = [
    // --- the exact assertions themeColorSystem.test.mjs makes ---
    ['paper/ink ≥ 7', contrast(paperC, inkC), 7],
    ['on-accent/accent ≥ 4.5', contrast(onAccentC, accentC), 4.5],
    ['fog on ink ≥ 4.5', contrast(color(t.fog, inkC), inkC), 4.5],
    ['mist on ink ≥ 4.5', contrast(color(t.mist, inkC), inkC), 4.5],
    ['fog on raised ≥ 4.5', contrast(color(t.fog, raisedC), raisedC), 4.5],
    ['mist on raised ≥ 4.5', contrast(color(t.mist, raisedC), raisedC), 4.5]
  ]
  // --- advisory copper-foreground rule (NOT the locked theme test) ---
  for (const surface of t.teakFgSurfaces) {
    checks.push([
      `copper fg on ${surface} ≥ 3`,
      contrast(teakFgC, color(surface)),
      3
    ])
  }

  for (const [label, value, min] of checks) {
    const pass = value >= min
    if (!pass) failed = true
    rows.push([`${t.name} (${id})`, label, round2(value), min, pass])
  }
}

const header = `${'主题'.padEnd(14)} ${'检查'.padEnd(24)} ${'实测'.padEnd(7)} ${'门槛'.padEnd(6)} 结果`
console.log(header)
console.log('-'.repeat(Math.max(header.length, 60)))
for (const [theme, label, value, min, pass] of rows) {
  console.log(
    `${theme.padEnd(14)} ${label.padEnd(24)} ${String(value).padEnd(7)} ${min.toFixed(1).padEnd(6)} ${pass ? 'OK  ' : 'FAIL'}`
  )
}

if (failed) {
  console.error('\nSome candidate accent combinations miss their contrast floor.')
  console.error('Adjust --on-accent (or the accent itself) before enabling the teak accent.')
  process.exit(1)
} else {
  console.log('\nAll warm-teak accent candidates pass every asserted contrast floor.')
}