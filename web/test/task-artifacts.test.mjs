import assert from 'node:assert/strict'
import test from 'node:test'
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
