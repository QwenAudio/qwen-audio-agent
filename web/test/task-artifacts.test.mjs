import assert from 'node:assert/strict'
import test from 'node:test'
import { artifactsFromAcpContentBlocks } from '../../server/src/backend/adapters/acp/content.mjs'
import { normalizeArtifacts } from '../../server/src/task/task-artifact.mjs'
import {
  artifactPartView,
  taskArtifactViews,
  taskHasArtifacts,
} from '../src/task-artifacts.js'

test('projects typed artifact parts for shared client presentation', () => {
  assert.deepEqual(artifactPartView({
    text: '# Report',
    mediaType: 'text/markdown',
    filename: 'report.md',
  }), {
    kind: 'text',
    content: '# Report',
    mediaType: 'text/markdown',
    filename: 'report.md',
  })
  assert.deepEqual(artifactPartView({
    data: { slides: 3 },
    mediaType: 'application/json',
  }), {
    kind: 'data',
    content: '{\n  "slides": 3\n}',
    mediaType: 'application/json',
    filename: '',
  })
  assert.deepEqual(artifactPartView({
    raw: 'aGVsbG8=',
    mediaType: 'application/octet-stream',
    filename: 'result.bin',
  }), {
    kind: 'file',
    href: 'data:application/octet-stream;base64,aGVsbG8=',
    mediaType: 'application/octet-stream',
    filename: 'result.bin',
    remote: false,
    index: 0,
  })
})

test('keeps remote artifact navigation on credential-free HTTP URLs', () => {
  assert.equal(artifactPartView({
    url: 'javascript:alert(1)',
    mediaType: 'text/html',
  }), null)
  assert.equal(artifactPartView({
    url: 'https://user:secret@example.com/report.pdf',
    mediaType: 'application/pdf',
  }), null)
  assert.deepEqual(artifactPartView({
    url: 'https://example.com/slides/preview.png',
    mediaType: 'image/png',
    filename: 'slide-01.png',
  }), {
    kind: 'image',
    href: 'https://example.com/slides/preview.png',
    mediaType: 'image/png',
    filename: 'slide-01.png',
    remote: true,
    index: 0,
  })
})

test('preserves inline ACP resource links through Gateway and client presentation', () => {
  const url = 'data:image/png;base64,aGVsbG8='
  const artifacts = normalizeArtifacts(artifactsFromAcpContentBlocks([{
    type: 'resource_link',
    uri: url,
    name: 'preview.png',
    mimeType: 'image/png',
  }]))
  const views = taskArtifactViews(artifacts)
  assert.equal(views.length, 1)
  assert.deepEqual(views[0].parts, [{
    kind: 'image',
    href: url,
    mediaType: 'image/png',
    filename: 'preview.png',
    remote: false,
    index: 0,
  }])
  assert.equal(taskHasArtifacts({ artifacts }), true)
})

test('keeps data URL files inline without enabling other URL schemes', () => {
  for (const url of [
    'data:application/pdf;base64,aGVsbG8=',
    'data:text/plain;charset=utf-8,hello%20world',
  ]) {
    const part = artifactPartView({ url, mediaType: 'application/octet-stream' })
    assert.equal(part.kind, 'file')
    assert.equal(part.href, url)
    assert.equal(part.remote, false)
  }
  for (const url of [
    'file:///tmp/result.png',
    'blob:https://example.com/private',
    'javascript:alert(1)',
    'data:image/png;base64',
    'https://user:secret@example.com/result.png',
  ]) {
    assert.equal(artifactPartView({ url, mediaType: 'image/png' }), null)
  }
})

test('drops empty artifacts and exposes only presentable artifacts', () => {
  const artifacts = [{
    artifactId: 'slides',
    name: 'Presentation',
    parts: [
      { url: 'file:///tmp/private.pptx', mediaType: 'application/vnd.ms-powerpoint' },
      { url: 'https://example.com/deck.pptx', mediaType: 'application/vnd.ms-powerpoint' },
    ],
  }, {
    artifactId: 'empty',
    parts: [],
  }]
  const views = taskArtifactViews(artifacts)
  assert.equal(views.length, 1)
  assert.equal(views[0].id, 'slides')
  assert.equal(views[0].parts.length, 1)
  assert.equal(taskHasArtifacts({ artifacts }), true)
  assert.equal(taskHasArtifacts({ artifacts: [] }), false)
})
