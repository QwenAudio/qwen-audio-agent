import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertDocumentExtractor,
  TextDocumentExtractor,
} from '../src/frontend/knowledge/document-extractor.mjs'

test('validates the document extractor port', () => {
  assert.throws(
    () => assertDocumentExtractor({ describe: () => ({ key: 'x', label: 'X' }) }),
    /supports, extract/,
  )
  assert.equal(
    assertDocumentExtractor(new TextDocumentExtractor()).describe().key,
    'builtin-text',
  )
})

test('extracts bounded UTF-8 text and infers the type from the filename', async () => {
  const extractor = new TextDocumentExtractor()
  const markdown = await extractor.extract({
    filename: 'notes.md',
    content: '# Notes\r\n\r\nHello\t world',
  })

  assert.equal(markdown.mimeType, 'text/markdown')
  assert.equal(markdown.title, 'notes.md')
  assert.equal(markdown.text, '# Notes\n\nHello\t world')
})

test('removes HTML controls while preserving readable content', async () => {
  const extractor = new TextDocumentExtractor()
  const result = await extractor.extract({
    filename: 'page.html',
    mimeType: 'text/html; charset=utf-8',
    content: '<h1>A &amp; B</h1><script>ignore()</script><p>Hello&nbsp;world</p>',
  })

  assert.equal(result.text, 'A & B\n\nHello world')
})

test('rejects unsupported, invalid, oversized, and aborted inputs', async () => {
  const extractor = new TextDocumentExtractor({ maxSourceBytes: 4 })
  await assert.rejects(
    extractor.extract({ filename: 'paper.pdf', content: 'pdf' }),
    error => error.code === 'unsupported_document_type',
  )
  await assert.rejects(
    extractor.extract({ filename: 'bad.txt', content: Buffer.from([0xc3, 0x28]) }),
    error => error.code === 'invalid_document_encoding',
  )
  await assert.rejects(
    extractor.extract({ filename: 'large.txt', content: '12345' }),
    error => error.code === 'document_too_large',
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    extractor.extract({ filename: 'notes.txt', content: 'text' }, {
      signal: controller.signal,
    }),
    error => error.code === 'document_extraction_aborted',
  )
})
