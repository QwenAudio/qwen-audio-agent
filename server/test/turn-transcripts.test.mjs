import assert from 'node:assert/strict'
import test from 'node:test'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'

test('correlates a late final transcript with the originating tool turn', async () => {
  const transcripts = new TurnTranscripts({ waitMs: 50 })
  const delegation = transcripts.resolveDelegation('turn-1', '列出用户下载目录')
  setTimeout(() => transcripts.record('turn-1', '查看下载目录'), 5)

  assert.deepEqual(await delegation, {
    originalRequest: '查看下载目录',
    objective: '列出用户下载目录',
  })
})

test('never borrows a transcript from a different turn', async () => {
  const transcripts = new TurnTranscripts({ waitMs: 5 })
  transcripts.record('turn-old', '旧问题')

  assert.deepEqual(await transcripts.resolveDelegation('turn-new', ''), {
    originalRequest: '',
    objective: '',
  })
  assert.deepEqual(
    await transcripts.resolveDelegation('turn-new', '明确的新任务'),
    {
      originalRequest: '明确的新任务',
      objective: '明确的新任务',
    },
  )
})

test('keeps multimodal parts bound to their originating turn', async () => {
  const transcripts = new TurnTranscripts({ waitMs: 5 })
  const image = {
    type: 'file',
    mime: 'image/png',
    url: 'data:image/png;base64,aGVsbG8=',
  }
  transcripts.recordParts('turn-image', [image])
  transcripts.record('turn-image', '分析这张图')

  assert.deepEqual(await transcripts.resolveDelegation('turn-image', '分析图片'), {
    originalRequest: '分析这张图',
    objective: '分析图片',
    inputParts: [image],
  })
  assert.deepEqual(transcripts.parts('other-turn'), [])
})
