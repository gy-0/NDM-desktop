import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cn } from '../src/renderer/src/lib/cn.ts'

test('named type roles survive beside text colours', () => {
  assert.equal(cn('text-label font-medium text-fog hover:text-paper'), 'text-label font-medium text-fog hover:text-paper')
  assert.equal(cn('text-meta text-mist', 'text-body'), 'text-mist text-body')
})

test('named radii, shadows and control metrics merge within their own groups', () => {
  assert.equal(cn('rounded-control rounded-surface'), 'rounded-surface')
  assert.equal(cn('shadow-popover shadow-dialog'), 'shadow-dialog')
  assert.equal(cn('h-control h-field'), 'h-field')
})
