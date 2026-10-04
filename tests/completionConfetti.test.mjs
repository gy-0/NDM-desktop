import assert from 'node:assert/strict'
import test from 'node:test'
import { completionPocketOwnsNotice } from '../src/renderer/src/lib/completionPresentation.ts'

test('the visible recent-files surface owns completion feedback in cards and idle lists', () => {
  const tasks = [{ id: 3, status: 'complete' }]
  assert.equal(completionPocketOwnsNotice({ id: 3 }, tasks, '', 'cards', true), true)
  assert.equal(completionPocketOwnsNotice({ id: 3 }, tasks, '', 'list', false), true)
})
test('completion outside the current search or filter keeps its actionable notice', () => {
  assert.equal(completionPocketOwnsNotice({ id: 3 }, [], '', 'cards', false), false)
  assert.equal(completionPocketOwnsNotice({ id: 3 }, [{ id: 3, status: 'complete' }], 'file', 'cards', false), false)
  assert.equal(completionPocketOwnsNotice({ id: 3 }, [{ id: 3, status: 'complete' }], '', 'list', true), false)
})
