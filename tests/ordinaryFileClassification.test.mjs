import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksLikeOrdinaryFileDownload } from '../src/renderer/src/lib/format.ts'

const ggufDownload = 'https://hf-mirror.com/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main/Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf?download=true&utm_source=chatgpt.com'

test('AI model artifacts bypass video probing', () => {
  assert.equal(looksLikeOrdinaryFileDownload(ggufDownload), true)
  assert.equal(looksLikeOrdinaryFileDownload('https://models.example/model.safetensors'), true)
  assert.equal(looksLikeOrdinaryFileDownload('https://models.example/model.onnx'), true)
  assert.equal(looksLikeOrdinaryFileDownload('https://models.example/model.ckpt'), true)
})

test('real video pages remain eligible for media probing', () => {
  assert.equal(looksLikeOrdinaryFileDownload('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false)
})
