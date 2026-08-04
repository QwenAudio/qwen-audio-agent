import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDesktopHostJsonLineDecoder,
  DESKTOP_HOST_METHODS,
  DESKTOP_HOST_PROTOCOL_VERSION,
  encodeDesktopHostMessage,
  MAX_DESKTOP_HOST_LINE_BYTES,
  parseDesktopHostMessage,
  redactDesktopHostValue,
} from '../shared/desktop-host-protocol.mjs'

test('desktop-host JSONL survives fragmented and coalesced chunks', () => {
  const messages = []
  const decoder = createDesktopHostJsonLineDecoder({
    onMessage: value => messages.push(value),
  })
  decoder.push(Buffer.from('{"event":"hel'))
  decoder.push(Buffer.from(
    'lo","data":{"protocol":1,"packageVersion":"1.2.0",'
    + '"nodeVersion":"22.22.2","distribution":"Ubuntu"}}\n'
    + '{"id":"1",',
  ))
  decoder.push(Buffer.from(
    '"ok":true,"result":{}}\n'
    + '{"id":"2","ok":false,"error":'
    + '{"code":"bad","message":"Bad request"}}\n',
  ))
  decoder.end()

  assert.equal(messages.length, 3)
  assert.equal(messages[0].event, 'hello')
  assert.equal(messages[2].id, '2')
  assert.equal(encodeDesktopHostMessage(messages[1]).endsWith('\n'), true)
})

test('validates the fixed request, response, and event envelopes', () => {
  for (const method of DESKTOP_HOST_METHODS) {
    assert.deepEqual(parseDesktopHostMessage({
      id: `request-${method}`,
      method,
      params: {},
    }), {
      id: `request-${method}`,
      method,
      params: {},
    })
  }

  assert.equal(DESKTOP_HOST_PROTOCOL_VERSION, 1)
  assert.equal(MAX_DESKTOP_HOST_LINE_BYTES, 1024 * 1024)
  assert.throws(() => parseDesktopHostMessage({
    id: 'unknown',
    method: 'shell.execute',
    params: {},
  }))
  assert.throws(() => parseDesktopHostMessage({
    id: 'extra',
    ok: true,
    result: {},
    unexpected: true,
  }))
  assert.throws(() => parseDesktopHostMessage({
    event: 'unknown.event',
    data: {},
  }))
})

test('decodes a split multibyte UTF-8 value', () => {
  const messages = []
  const errors = []
  const decoder = createDesktopHostJsonLineDecoder({
    onMessage: value => messages.push(value),
    onError: error => errors.push(error),
  })
  const encoded = Buffer.from(
    '{"event":"gateway.status","data":{"message":"启动中"}}\n',
  )
  const splitAt = encoded.indexOf(Buffer.from('启')) + 1
  decoder.push(encoded.subarray(0, splitAt))
  decoder.push(encoded.subarray(splitAt))
  decoder.end()

  assert.deepEqual(errors, [])
  assert.equal(messages[0].data.message, '启动中')
})

test('reports malformed JSON and continues at the next complete line', () => {
  const messages = []
  const errors = []
  const decoder = createDesktopHostJsonLineDecoder({
    onMessage: value => messages.push(value),
    onError: error => errors.push(error),
  })
  decoder.push(Buffer.from(
    '{"event":broken}\n'
    + '{"event":"gateway.status","data":{"state":"ready"}}\n',
  ))
  decoder.end()

  assert.equal(errors.length, 1)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].data.state, 'ready')
})

test('reports an unfinished final line without emitting it', () => {
  const messages = []
  const errors = []
  const decoder = createDesktopHostJsonLineDecoder({
    onMessage: value => messages.push(value),
    onError: error => errors.push(error),
  })
  decoder.push(Buffer.from(
    '{"event":"gateway.status","data":{"state":"ready"}}',
  ))
  decoder.end()

  assert.deepEqual(messages, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /unterminated/i)
})

test('rejects an oversized line and resumes only after its newline', () => {
  const messages = []
  const errors = []
  const decoder = createDesktopHostJsonLineDecoder({
    onMessage: value => messages.push(value),
    onError: error => errors.push(error),
    maxLineBytes: 80,
  })
  decoder.push(Buffer.from(
    `{"event":"gateway.status","data":{"message":"${'x'.repeat(100)}`,
  ))
  decoder.push(Buffer.from(
    '"}}\n{"event":"gateway.status","data":{"state":"ready"}}\n',
  ))
  decoder.end()

  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /80 bytes/)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].data.state, 'ready')
})

test('rejects encoded messages larger than the configured protocol bound', () => {
  assert.throws(() => encodeDesktopHostMessage({
    event: 'gateway.status',
    data: { message: 'x'.repeat(MAX_DESKTOP_HOST_LINE_BYTES) },
  }), /1048576 bytes/)
})

test('redacts nested secret keys and bearer credentials without mutation', () => {
  const input = {
    configured: true,
    dashscopeApiKey: 'sk-secret-value',
    nested: {
      authorization: 'Bearer abc.def.ghi',
      access_key: 'access-secret',
      refreshToken: 'refresh-secret',
      message: 'Request failed for Bearer visible-credential at gateway',
      attempts: 2,
    },
  }

  assert.deepEqual(redactDesktopHostValue(input), {
    configured: true,
    dashscopeApiKey: '[REDACTED]',
    nested: {
      authorization: '[REDACTED]',
      access_key: '[REDACTED]',
      refreshToken: '[REDACTED]',
      message: 'Request failed for Bearer [REDACTED] at gateway',
      attempts: 2,
    },
  })
  assert.equal(input.dashscopeApiKey, 'sk-secret-value')
})

test('redacts secrets in arrays and handles circular diagnostics', () => {
  const circular = { password: 'hidden' }
  circular.self = circular

  assert.deepEqual(redactDesktopHostValue([
    'Bearer token-value',
    { clientSecret: 'hidden', ok: false },
  ]), [
    'Bearer [REDACTED]',
    { clientSecret: '[REDACTED]', ok: false },
  ])
  assert.deepEqual(redactDesktopHostValue(circular), {
    password: '[REDACTED]',
    self: '[Circular]',
  })
})
