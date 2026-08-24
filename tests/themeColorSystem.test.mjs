import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/renderer/src/index.css', 'utf8')
const mainProcess = readFileSync('src/main/index.ts', 'utf8')
const emptyState = readFileSync('src/renderer/src/components/EmptyState.tsx', 'utf8')
const sidebar = readFileSync('src/renderer/src/components/Sidebar.tsx', 'utf8')

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

test('each appearance keeps text readable across base and raised surfaces', () => {
  for (const id of ['walnut', 'dawn', 'noon']) {
    const block = themeBlock(id)
    const ink = color(token(block, 'ink'))
    const raised = color(token(block, 'raised'))
    const paper = color(token(block, 'paper'))
    const accent = color(token(block, 'accent'))
    const onAccent = color(token(block, 'on-accent'))

    assert.ok(contrast(paper, ink) >= 7, `${id} primary text misses 7:1`)
    assert.ok(contrast(onAccent, accent) >= 4.5, `${id} primary action misses 4.5:1`)
    for (const surface of [ink, raised]) {
      assert.ok(contrast(color(token(block, 'fog'), surface), surface) >= 4.5, `${id} secondary text misses 4.5:1`)
      assert.ok(contrast(color(token(block, 'mist'), surface), surface) >= 4.5, `${id} muted text misses 4.5:1`)
    }
  }
})

test('core appearances contain no stock AI blue or amber wash', () => {
  const blocks = ['walnut', 'dawn', 'noon'].map(themeBlock).join('\n')
  assert.doesNotMatch(blocks, /#(?:365fd9|97acff|3478f6|d79343|b86e36|d08a3a)/i)
  assert.equal((blocks.match(/--hero-glow:\s*transparent/g) ?? []).length, 3)
})

test('native window shell matches the renderer on its first frame', () => {
  for (const [id, background, symbol] of [
    ['walnut', '#101114', '#f5f5f7'],
    ['dawn', '#f1f1ef', '#1c1d20'],
    ['noon', '#f5f6f7', '#181a1e']
  ]) {
    assert.match(mainProcess, new RegExp(`${id}: '${background}'`))
    assert.match(mainProcess, new RegExp(`${id}: '${symbol}'`))
  }
  assert.doesNotMatch(mainProcess, /#(?:141210|f4efe6|f5f4f0|f7efe2)/i)
})

test('empty and navigation states do not manufacture attention with motion', () => {
  assert.doesNotMatch(emptyState, /motion|gradient|boxShadow|animate-/)
  assert.doesNotMatch(sidebar, /animate-pulse|type:\s*['"]spring['"]|sidebar-active-indicator/)
})
