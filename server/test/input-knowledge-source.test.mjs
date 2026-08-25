import assert from 'node:assert/strict'
import test from 'node:test'
import { knowledgeSourcesFromInputParts } from '../src/voice/input-knowledge-source.mjs'

function dataUrl(text, mime = 'text/plain') {
  return `data:${mime};base64,${Buffer.from(text).toString('base64')}`
}

test('converts only inline file parts into bounded knowledge sources', () => {
  const sources = knowledgeSourcesFromInputParts([
    { type: 'text', text: 'save this' },
    {
      type: 'file',
      mime: 'text/markdown',
      filename: 'guide.md',
      url: dataUrl('# Guide', 'text/markdown'),
      source: { type: 'file', path: '/Users/me/private/guide.md' },
    },
  ])

  assert.equal(sources.length, 1)
  assert.equal(sources[0].filename, 'guide.md')
  assert.equal(sources[0].mimeType, 'text/markdown')
  assert.equal(sources[0].content.toString('utf8'), '# Guide')
  assert.match(sources[0].id, /^attachment:/)
  assert.notEqual(sources[0].id, '/Users/me/private/guide.md')
})

test('rejects remote attachment URLs instead of fetching them during indexing', () => {
  assert.throws(
    () => knowledgeSourcesFromInputParts([{
      type: 'file',
      mime: 'text/plain',
      filename: 'remote.txt',
      url: 'https://example.com/remote.txt',
    }]),
    error => error.code === 'knowledge_input_not_inline',
  )
})
