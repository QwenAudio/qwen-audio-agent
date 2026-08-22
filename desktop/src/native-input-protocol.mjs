export const MAX_FRAME_PAYLOAD_BYTES = 65_536

export const NATIVE_INPUT_MESSAGE_TYPES = Object.freeze([
  'bridge.ready',
  'session.arm',
  'session.partial',
  'session.final',
  'session.cancel',
  'session.pause',
  'session.resume',
  'session.state',
  'bridge.stop',
  'bridge.error',
])

const messageTypes = new Set(NATIVE_INPUT_MESSAGE_TYPES)
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export class NativeInputProtocolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NativeInputProtocolError'
    this.code = code
  }
}

export function encodeNativeInputFrame(message) {
  validateMessage(message)
  let payload
  try {
    payload = Buffer.from(JSON.stringify(message), 'utf8')
  } catch {
    throw protocolError('invalid_json', 'Message is not JSON encodable')
  }
  if (payload.length === 0) {
    throw protocolError('zero_length', 'Frame payload is empty')
  }
  if (payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw protocolError('oversized', 'Frame payload exceeds 64 KiB')
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.length)
  return Buffer.concat([header, payload])
}

export function decodeNativeInputFrame(bytes) {
  const frame = Buffer.from(bytes)
  if (frame.length < 4) throw protocolError('truncated', 'Missing frame header')
  const length = readLength(frame)
  const expected = 4 + length
  if (frame.length < expected) throw protocolError('truncated', 'Partial frame')
  if (frame.length > expected) {
    throw protocolError('trailing_bytes', 'Frame contains trailing bytes')
  }
  return decodePayload(frame.subarray(4))
}

export class NativeInputFrameDecoder {
  #buffer = Buffer.alloc(0)

  push(bytes) {
    const chunk = Buffer.from(bytes)
    if (chunk.length > 0) this.#buffer = Buffer.concat([this.#buffer, chunk])
    const messages = []
    while (this.#buffer.length >= 4) {
      const length = readLength(this.#buffer)
      const frameLength = 4 + length
      if (this.#buffer.length < frameLength) break
      messages.push(decodePayload(this.#buffer.subarray(4, frameLength)))
      this.#buffer = this.#buffer.subarray(frameLength)
    }
    return messages
  }

  finish() {
    if (this.#buffer.length !== 0) {
      throw protocolError('truncated', 'Stream ended during a frame')
    }
  }
}

function readLength(frame) {
  const length = frame.readUInt32BE(0)
  if (length === 0) throw protocolError('zero_length', 'Frame payload is empty')
  if (length > MAX_FRAME_PAYLOAD_BYTES) {
    throw protocolError('oversized', 'Frame payload exceeds 64 KiB')
  }
  return length
}

function decodePayload(payload) {
  let text
  try {
    text = utf8Decoder.decode(payload)
  } catch {
    throw protocolError('invalid_utf8', 'Frame is not valid UTF-8')
  }
  let message
  try {
    message = JSON.parse(text)
  } catch {
    throw protocolError('invalid_json', 'Frame is not valid JSON')
  }
  validateMessage(message)
  return message
}

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw protocolError('invalid_json', 'Message must be an object')
  }
  if (!messageTypes.has(message.type)) {
    throw protocolError('unknown_type', 'Unknown native input message type')
  }
}

function protocolError(code, message) {
  return new NativeInputProtocolError(code, message)
}
