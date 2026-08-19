const TERMINAL_PUNCTUATION = '[.!?。！？]?'
const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])
const SHA256_ROUND = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function terminalCommand(source) {
  const chinese = source.match(
    new RegExp(
      `^(?:(.*[\\s,，;；.!?。！？:：]))?(发送|提交)${TERMINAL_PUNCTUATION}\\s*$`,
      'u',
    ),
  )
  if (chinese) {
    return {
      kind: 'commit',
      text: (chinese[1] || '').trim(),
      command: chinese[2],
    }
  }
  const english = source.match(
    new RegExp(`^(.*?)(?:^|\\s)(send|submit)${TERMINAL_PUNCTUATION}\\s*$`, 'iu'),
  )
  if (!english) return null
  return {
    kind: 'commit',
    text: english[1].trim(),
    command: english[2].toLowerCase(),
  }
}

export function parseDictationIntent(value) {
  const source = String(value || '').trim()
  const send = terminalCommand(source)
  if (send) return send

  const chineseReplace = source.match(/^把(.+?)改成(.+)$/u)
  if (chineseReplace) {
    return {
      kind: 'replace',
      target: chineseReplace[1].trim(),
      replacement: chineseReplace[2].trim(),
    }
  }
  const englishReplace = source.match(/^replace\s+(.+?)\s+with\s+(.+)$/iu)
  if (englishReplace) {
    return {
      kind: 'replace',
      target: englishReplace[1].trim(),
      replacement: englishReplace[2].trim(),
    }
  }
  const chineseDelete = source.match(/^删除(.+)$/u)
  if (chineseDelete) {
    return { kind: 'delete', target: chineseDelete[1].trim() }
  }
  const englishDelete = source.match(/^delete\s+(.+)$/iu)
  if (englishDelete) {
    return { kind: 'delete', target: englishDelete[1].trim() }
  }
  if (
    /^(?:改得|改写|润色|精简|扩写)/u.test(source)
    || /^(?:make\s+it|rewrite|polish|shorten|expand)\b/iu.test(source)
  ) {
    return { kind: 'rewrite', instruction: source }
  }
  return { kind: 'insert', text: source }
}

function normalizedSnapshot(snapshot = {}) {
  const text = String(snapshot.text || '')
  const start = Math.max(0, Math.min(text.length, Number(snapshot.selectionStart) || 0))
  const end = Math.max(start, Math.min(
    text.length,
    Number(snapshot.selectionEnd) || start,
  ))
  return {
    text,
    selectionStart: start,
    selectionEnd: end,
    revision: Math.max(0, Number(snapshot.revision) || 0),
  }
}

function applied(text, caret, revision) {
  return {
    applied: true,
    text,
    selectionStart: caret,
    selectionEnd: caret,
    revision: revision + 1,
  }
}

export function applyDraftOperation(snapshot, operation = {}) {
  const current = normalizedSnapshot(snapshot)
  if (Number(operation.baseRevision) !== current.revision) {
    return {
      applied: false,
      reason: 'revision_conflict',
      revision: current.revision,
    }
  }
  if (operation.kind === 'insert') {
    const value = String(operation.text || '')
    const text = current.text.slice(0, current.selectionStart)
      + value
      + current.text.slice(current.selectionEnd)
    return applied(text, current.selectionStart + value.length, current.revision)
  }
  if (operation.kind === 'rewrite') {
    const text = String(operation.text || '')
    return applied(text, text.length, current.revision)
  }
  if (operation.kind === 'replace' || operation.kind === 'delete') {
    const target = String(operation.target || '')
    const index = target ? current.text.indexOf(target) : -1
    if (index < 0) {
      return {
        applied: false,
        reason: 'target_not_found',
        revision: current.revision,
      }
    }
    const replacement = operation.kind === 'replace'
      ? String(operation.text || '')
      : ''
    const text = current.text.slice(0, index)
      + replacement
      + current.text.slice(index + target.length)
    return applied(text, index + replacement.length, current.revision)
  }
  return {
    applied: false,
    reason: 'unsupported_operation',
    revision: current.revision,
  }
}

export function draftPayloadHash(value) {
  const input = new TextEncoder().encode(String(value || ''))
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  const bitLength = input.length * 8
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)
  const hash = [...SHA256_INITIAL]
  const words = new Uint32Array(64)
  const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits))
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false)
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]
      const right = words[index - 2]
      const sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3)
      const sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temporary1 = (h + sum1 + choice + SHA256_ROUND[index] + words[index]) >>> 0
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }
    const round = [a, b, c, d, e, f, g, h]
    for (let index = 0; index < hash.length; index += 1) {
      hash[index] = (hash[index] + round[index]) >>> 0
    }
  }
  return hash.map(word => word.toString(16).padStart(8, '0')).join('')
}
