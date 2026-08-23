import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const collection = fs.readFileSync('src/renderer/src/components/CollectionRow.tsx', 'utf8')
const store = fs.readFileSync('src/renderer/src/lib/store.ts', 'utf8')

test('collection controls require an engine acknowledgement', () => {
  assert.match(store, /request\('pauseCollection', \{ collectionID \}\)[\s\S]*?if \(!reply\?\.ok\) throw new Error\('未能暂停合集'\)/)
  assert.match(store, /request\('resumeCollection', \{ collectionID \}\)[\s\S]*?if \(!reply\?\.ok\) throw new Error\('未能继续合集'\)/)
})

test('collection controls expose busy and retryable failure states in place', () => {
  assert.match(collection, /const \[groupActionBusy, setGroupActionBusy\]/)
  assert.match(collection, /await pauseCollection\(collectionID\)/)
  assert.match(collection, /await resumeCollection\(collectionID\)/)
  assert.match(collection, /未能继续整个合集。请检查下载引擎后重试。/)
  assert.match(collection, /role=\{groupActionError \? 'status'/)
  assert.match(collection, /aria-live="polite"/)
  assert.match(collection, /disabled=\{groupActionBusy\}/)
  assert.match(collection, /aria-describedby=\{groupActionError/)
})
