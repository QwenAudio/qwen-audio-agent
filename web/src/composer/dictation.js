const SEND_COMMANDS = new Set(['发送', '提交', 'send', 'submit'])
const SENTENCE_END = /[.!?。！？]+$/u

export function normalizeDictationText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim()
}

function stripTrailingPunctuation(value) {
  return value.replace(/[.,!?;:，。！？；：、]+$/gu, '').trim()
}

function sendCommand(value) {
  const normalized = normalizeDictationText(value)
  const comparable = stripTrailingPunctuation(normalized).toLocaleLowerCase()
  if (SEND_COMMANDS.has(comparable)) {
    return { type: 'send', body: '' }
  }
  const sentence = normalized.match(
    /^(.+?)[.!?。！？]+\s*(发送|提交|send|submit)$/iu,
  )
  if (sentence && SEND_COMMANDS.has(sentence[2].toLocaleLowerCase())) {
    return { type: 'send', body: sentence[1].trim() }
  }
  return null
}

export function parseDictationCommand(value) {
  const normalized = normalizeDictationText(value)
  if (!normalized) return { type: 'empty', text: '' }

  const send = sendCommand(normalized)
  if (send) return send

  const replace = normalized.match(
    /^把\s*(.+?)\s*(?:改成|换成)\s*(.+)$/u,
  ) || normalized.match(
    /^(?:change|replace)\s+(.+?)\s+to\s+(.+)$/iu,
  )
  if (replace) {
    return {
      type: 'replace',
      from: replace[1].trim(),
      to: replace[2].trim(),
    }
  }

  if (/^(?:删掉|删除|移除)\s*(?:最后一句|上一句)$/u.test(normalized)) {
    return { type: 'delete-last-sentence' }
  }

  return { type: 'append', text: normalized }
}

export function appendDictationText(draft, addition) {
  const left = String(draft || '').trimEnd()
  const right = normalizeDictationText(addition)
  if (!left) return right
  if (!right) return left
  if (
    /[\s([{（「“]$/u.test(left)
    || /^[,.;:!?，。！？；：、)\]}」”]/u.test(right)
    || /[\u4e00-\u9fff]$/u.test(left)
    || /^[\u4e00-\u9fff]/u.test(right)
  ) {
    return `${left}${right}`
  }
  return `${left} ${right}`
}

function deleteLastSentence(draft) {
  const value = String(draft || '').trimEnd()
  if (!value) return ''
  const body = SENTENCE_END.test(value) ? value.replace(SENTENCE_END, '').trimEnd() : value
  const boundaries = [...body.matchAll(/[.!?。！？]/gu)]
  if (!boundaries.length) return ''
  return body.slice(0, boundaries.at(-1).index + 1).trimEnd()
}

export function applyDictationCommand(draft, value) {
  const command = parseDictationCommand(value)
  const current = String(draft || '')
  if (command.type === 'empty') {
    return { ...command, draft: current, changed: false }
  }
  if (command.type === 'append' || command.type === 'send') {
    const next = appendDictationText(current, command.body || command.text)
    return { ...command, draft: next, changed: next !== current }
  }
  if (command.type === 'replace') {
    const next = current.replace(command.from, command.to)
    return { ...command, draft: next, changed: next !== current }
  }
  const next = deleteLastSentence(current)
  return { ...command, draft: next, changed: next !== current }
}

export function isDictationShortcut(event) {
  return Boolean(
    event
    && (event.ctrlKey || event.metaKey)
    && event.shiftKey
    && event.code === 'Space',
  )
}

export function speechRecognitionConstructor(scope = globalThis) {
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null
}
