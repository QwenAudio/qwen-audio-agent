import assert from 'node:assert/strict'
import test from 'node:test'
import {
  artifactFromInlinePresentation,
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

test('adapts the legacy inline presentation into one stable artifact', () => {
  const presentation = {
    speech: '报告已完成。',
    inline: { title: '报告', format: 'code', content: 'const done = true' },
  }
  const artifact = artifactFromInlinePresentation(presentation)
  assert.deepEqual(artifactsFromOutcome({ metadata: {} }, presentation), [
    artifact,
  ])
  assert.deepEqual(artifact, {
    artifactId: 'artifact_inline',
    name: '报告',
    parts: [{ text: 'const done = true', mediaType: 'text/markdown' }],
  })
})

test('prefers backend artifacts over the inline compatibility projection', () => {
  const artifacts = artifactsFromOutcome({
    artifacts: [{
      artifactId: 'image',
      parts: [{
        url: 'https://example.com/cat.png',
        mediaType: 'image/png',
      }],
    }],
  }, {
    inline: { title: 'ignored', format: 'markdown', content: 'ignored' },
  })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].artifactId, 'image')
})
