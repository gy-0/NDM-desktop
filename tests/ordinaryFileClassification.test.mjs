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

test('proxy-wrapped file URLs count as ordinary downloads', () => {
  const ezproxyZip =
    'https://ezproxy.library.mcmaster.ca/login?url=https%3A%2F%2Fwww.cambridge.org%2Ffiles%2Fdownloads%2Fsomething.zip'
  assert.equal(looksLikeOrdinaryFileDownload(ezproxyZip), true)
  const ezproxyPdf =
    'https://ezproxy.example.edu/login?target=http%3A%2F%2Ffiles.host.org%2Fpapers%2Fpaper.pdf'
  assert.equal(looksLikeOrdinaryFileDownload(ezproxyPdf), true)
})

test('proxy-wrapped web pages stay eligible for media probing', () => {
  const ezproxyPage =
    'https://ezproxy.library.mcmaster.ca/login?url=https%3A%2F%2Fwww.cambridge.org%2Fcore%2Fjournals%2Farticle'
  assert.equal(looksLikeOrdinaryFileDownload(ezproxyPage), false)
})
