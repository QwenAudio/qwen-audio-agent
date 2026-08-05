import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INLINE_TITLE_MAX_CHARS,
  normalizeInlinePresentation,
} from '../src/core/inline-presentation.mjs'

test('inline presentation requires content', () => {
  assert.equal(normalizeInlinePresentation(null), null)
  assert.equal(normalizeInlinePresentation('code'), null)
  assert.equal(normalizeInlinePresentation({ title: '空' }), null)
  assert.equal(normalizeInlinePresentation({ content: '   ' }), null)
})

test('an unsupported format degrades to markdown', () => {
  assert.equal(
    normalizeInlinePresentation({ content: 'x', format: 'html' }).format,
    'markdown',
  )
  assert.equal(
    normalizeInlinePresentation({ content: 'x', format: 'code' }).format,
    'code',
  )
  assert.equal(
    normalizeInlinePresentation({ content: 'x', format: 'link' }).format,
    'link',
  )
})

test('a title is bounded and a missing title stays empty', () => {
  const long = normalizeInlinePresentation({
    content: 'x',
    title: '标'.repeat(INLINE_TITLE_MAX_CHARS + 40),
  })
  assert.equal(long.title.length, INLINE_TITLE_MAX_CHARS)
  assert.equal(normalizeInlinePresentation({ content: 'x' }).title, '')
})

test('content is kept whole unless a bound is requested', () => {
  const content = 'def quick_sort(arr):\n    return arr'
  assert.equal(normalizeInlinePresentation({ content }).content, content)
  assert.equal(
    normalizeInlinePresentation({ content }, { maxContentChars: 10 }).content,
    content.slice(0, 10),
  )
})
