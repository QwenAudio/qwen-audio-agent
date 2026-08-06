import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeImage,
  visionDescriberAvailable,
} from '../src/agent/vision-describer.mjs'

const image = { base64: 'aW1n', mimeType: 'image/png' }

function responder(payload, { ok = true, status = 200 } = {}) {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers })
      return { ok, status, json: async () => payload }
    },
  }
}

test('is only available with both a model and a key', () => {
  assert.equal(visionDescriberAvailable({ visionModel: 'm', apiKey: 'k' }), true)
  assert.equal(visionDescriberAvailable({ visionModel: 'm', apiKey: '' }), false)
  assert.equal(visionDescriberAvailable({ visionModel: '', apiKey: 'k' }), false)
  assert.equal(visionDescriberAvailable(), false)
})

test('asks chat/completions with the image and returns the description', async () => {
  const { calls, fetchImpl } = responder({
    choices: [{ message: { content: '一张 VS Code 截图' } }],
  })
  const result = await describeImage(image, {
    visionModel: 'qwen3-vl-plus',
    visionModelUrl: 'https://example.com/compatible-mode/v1/',
    apiKey: 'secret',
    fetchImpl,
  })

  const [call] = calls
  // Bailian serves multimodal models only on chat/completions; /v1/responses
  // answers "Unsupported model".
  assert.equal(call.url, 'https://example.com/compatible-mode/v1/chat/completions')
  assert.equal(call.headers.Authorization, 'Bearer secret')
  assert.equal(call.body.model, 'qwen3-vl-plus')
  const [imagePart, textPart] = call.body.messages[0].content
  assert.equal(imagePart.image_url.url, 'data:image/png;base64,aW1n')
  assert.match(textPart.text, /客观描述/)

  assert.equal(result.text, '一张 VS Code 截图')
  assert.equal(result.model, 'qwen3-vl-plus')
})

test('passes the caller question through instead of the default prompt', async () => {
  const { calls, fetchImpl } = responder({
    choices: [{ message: { content: 'ok' } }],
  })
  await describeImage(image, {
    visionModel: 'm',
    visionModelUrl: 'https://example.com/v1',
    apiKey: 'k',
    question: '这个报错什么意思',
    fetchImpl,
  })
  assert.equal(calls[0].body.messages[0].content[1].text, '这个报错什么意思')
})

test('falls back to reasoning_content when content is empty', async () => {
  // Some reasoning models fill only the thinking field; an empty answer is
  // worse than the thinking text.
  const { fetchImpl } = responder({
    choices: [{ message: { content: '', reasoning_content: '看起来是终端' } }],
  })
  const result = await describeImage(image, {
    visionModel: 'm',
    visionModelUrl: 'https://example.com/v1',
    apiKey: 'k',
    fetchImpl,
  })
  assert.equal(result.text, '看起来是终端')
})

test('reports a model error, an HTTP failure, and an empty answer', async () => {
  await assert.rejects(describeImage(image, {
    visionModel: 'nope',
    visionModelUrl: 'https://example.com/v1',
    apiKey: 'k',
    fetchImpl: responder({ error: { message: 'Unsupported model' } }).fetchImpl,
  }), /Unsupported model/)

  await assert.rejects(describeImage(image, {
    visionModel: 'm',
    visionModelUrl: 'https://example.com/v1',
    apiKey: 'k',
    fetchImpl: responder(null, { ok: false, status: 503 }).fetchImpl,
  }), /HTTP 503/)

  await assert.rejects(describeImage(image, {
    visionModel: 'm',
    visionModelUrl: 'https://example.com/v1',
    apiKey: 'k',
    fetchImpl: responder({ choices: [{ message: {} }] }).fetchImpl,
  }), /未返回描述/)
})

test('refuses to call out without a model, a key, or image data', async () => {
  const { calls, fetchImpl } = responder({})
  await assert.rejects(
    describeImage(image, { visionModelUrl: 'x', apiKey: 'k', fetchImpl }),
    /未配置视觉模型/,
  )
  await assert.rejects(
    describeImage(image, { visionModel: 'm', visionModelUrl: 'x', fetchImpl }),
    /缺少 API Key/,
  )
  await assert.rejects(
    describeImage({ base64: '' }, {
      visionModel: 'm',
      visionModelUrl: 'x',
      apiKey: 'k',
      fetchImpl,
    }),
    /图片数据不完整/,
  )
  assert.equal(calls.length, 0, 'nothing should be sent for invalid input')
})
