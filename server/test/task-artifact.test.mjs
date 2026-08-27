import assert from 'node:assert/strict'
import test from 'node:test'
import {
  artifactsFromOutcome,
  normalizeArtifacts,
} from '../src/task/task-artifact.mjs'

test('normalizes A2A-aligned MIME-typed artifact parts', () => {
  assert.deepEqual(normalizeArtifacts([{
    id: 'report',
    name: '系统报告',
    description: '检查结果',
    parts: [
      { text: '# 完成', mimeType: 'Text/Markdown' },
      { data: { memoryGb: 24 } },
      {
        url: 'https://example.com/report.pdf',
        mediaType: 'application/pdf',
        filename: 'report.pdf',
      },
    ],
  }]), [{
    artifactId: 'report',
    name: '系统报告',
    description: '检查结果',
    parts: [
      { text: '# 完成', mediaType: 'text/markdown' },
      { data: { memoryGb: 24 }, mediaType: 'application/json' },
      {
        url: 'https://example.com/report.pdf',
        mediaType: 'application/pdf',
        filename: 'report.pdf',
      },
    ],
  }])
})

test('drops duplicate artifacts and unsafe or malformed parts', () => {
  assert.deepEqual(normalizeArtifacts([
    {
      artifactId: 'one',
      parts: [
        { url: 'javascript:alert(1)', mediaType: 'text/html' },
        { raw: 'not base64!', mediaType: 'image/png' },
        { text: 'safe' },
      ],
    },
    { artifactId: 'one', parts: [{ text: 'duplicate' }] },
    { artifactId: 'empty', parts: [] },
  ]), [{
    artifactId: 'one',
    parts: [{ text: 'safe', mediaType: 'text/plain' }],
  }])
})

test('normalizes artifacts supplied by a backend outcome', () => {
  const artifacts = artifactsFromOutcome({
    artifacts: [{
      artifactId: 'image',
      parts: [{
        url: 'https://example.com/cat.png',
        mediaType: 'image/png',
      }],
    }],
  })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].artifactId, 'image')
})

test('accepts the legacy metadata location without a presentation fallback', () => {
  const artifacts = artifactsFromOutcome({
    metadata: {
      artifacts: [{ artifactId: 'report', parts: [{ text: '# Report' }] }],
    },
  })
  assert.deepEqual(artifacts, [{
    artifactId: 'report',
    parts: [{ text: '# Report', mediaType: 'text/plain' }],
  }])
})
