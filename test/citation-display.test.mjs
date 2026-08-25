import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCitationLines } from '../shared/citation-display.mjs'

test('formats safe unique citations for terminal clients', () => {
  assert.equal(formatCitationLines([
    { title: '杭州天气', url: 'https://example.com/weather' },
    { title: '重复', url: 'https://example.com/weather' },
    { title: '危险', url: 'file:///etc/passwd' },
  ]), [
    '来源',
    '  [1] 杭州天气 — https://example.com/weather',
  ].join('\n'))
})

test('omits a citation section when no displayable source exists', () => {
  assert.equal(formatCitationLines(null), '')
  assert.equal(formatCitationLines([{
    title: '密钥',
    url: 'https://user:secret@example.com/',
  }]), '')
})
