import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const confetti = fs.readFileSync('src/renderer/src/components/ui/confetti.tsx', 'utf8')

test('completion confetti starts centrally without a clipped product-region canvas', () => {
  assert.match(app, /particleCount: 64/)
  assert.match(app, /spread: 360/)
  assert.match(app, /origin: \{ x: 0\.5, y: 0\.52 \}/)
  assert.match(app, /fullscreen/)
  assert.match(app, /h-\[100dvh\] w-\[100dvw\]/)
  assert.match(confetti, /createPortal\(canvas, document\.body\)/)
})
