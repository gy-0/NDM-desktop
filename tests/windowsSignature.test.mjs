import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectAuthenticode } from '../scripts/windowsSignature.mjs'

function peFixture({ pe32Plus = true, certificate = true, malformed = false } = {}) {
  const peOffset = 0x80
  const optionalOffset = peOffset + 24
  const directoriesOffset = optionalOffset + (pe32Plus ? 112 : 96)
  const certificateOffset = 0x200
  const certificateSize = 24
  const buffer = Buffer.alloc(0x240)
  buffer.writeUInt16LE(0x5a4d, 0)
  buffer.writeUInt32LE(peOffset, 0x3c)
  buffer.writeUInt32LE(0x00004550, peOffset)
  buffer.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, optionalOffset)
  buffer.writeUInt32LE(16, optionalOffset + (pe32Plus ? 108 : 92))
  if (certificate) {
    buffer.writeUInt32LE(certificateOffset, directoriesOffset + (4 * 8))
    buffer.writeUInt32LE(certificateSize, directoriesOffset + (4 * 8) + 4)
    buffer.writeUInt32LE(malformed ? certificateSize + 1 : certificateSize, certificateOffset)
    buffer.writeUInt16LE(0x0200, certificateOffset + 4)
    buffer.writeUInt16LE(0x0002, certificateOffset + 6)
  }
  return buffer
}

test('Authenticode parser accepts bounded PKCS#7 certificate tables in PE32 and PE32+', () => {
  assert.equal(inspectAuthenticode(peFixture({ pe32Plus: false })).present, true)
  assert.equal(inspectAuthenticode(peFixture({ pe32Plus: true })).present, true)
})

test('Authenticode parser distinguishes unsigned and malformed executables', () => {
  assert.match(inspectAuthenticode(peFixture({ certificate: false })).reason, /未嵌入/)
  assert.match(inspectAuthenticode(peFixture({ malformed: true })).reason, /长度无效/)
  assert.match(inspectAuthenticode(Buffer.from('not a PE')).reason, /不是有效/)
})
