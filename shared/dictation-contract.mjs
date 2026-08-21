const TERMINAL_PUNCTUATION = /[.!?。！？；;]\s*$/u

export function parseFinalSegment(value) {
  const source = String(value || '').trim()
  const command = /^(?:send|发送)$/iu
  if (command.test(source)) return { text: '', send: true }
  const match = source.match(/^(.*?[.!?。！？；;])\s*(?:send|发送)$/iu)
  if (match && TERMINAL_PUNCTUATION.test(match[1])) {
    return { text: match[1].trim(), send: true }
  }
  return { text: source, send: false }
}

export function textFingerprint(value) {
  let hash = 2166136261
  for (const character of String(value || '')) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export class CommitReceipts {
  constructor(limit = 200) {
    this.limit = Math.max(1, limit)
    this.values = new Set()
  }

  accept(id) {
    const key = String(id || '')
    if (!key || this.values.has(key)) return false
    this.values.add(key)
    while (this.values.size > this.limit) {
      this.values.delete(this.values.values().next().value)
    }
    return true
  }
}

export class ComposerDictation {
  constructor(text = '') {
    this.text = String(text)
    this.pending = ''
    this.revision = 0
    this.range = null
    this.sequence = 0
  }

  snapshot() {
    return {
      text: this.text,
      partial: this.pending,
      revision: this.revision,
      range: this.range ? { ...this.range } : null,
    }
  }

  accepts(revision, seq) {
    return Number(revision) === this.revision
      && Number.isInteger(seq)
      && seq > this.sequence
  }

  partial({ text, revision, seq }) {
    if (!this.accepts(revision, seq)) return false
    this.sequence = seq
    this.pending = String(text || '')
    return true
  }

  final({ text, revision, seq }) {
    if (!this.accepts(revision, seq)) return false
    this.sequence = seq
    const value = String(text || '')
    const start = this.text.length
    this.text += value
    this.pending = ''
    this.range = { start, end: start + value.length }
    this.revision += 1
    return true
  }

  settlePartial() {
    if (!this.pending) return false
    const start = this.text.length
    this.text += this.pending
    this.range = { start, end: this.text.length }
    this.pending = ''
    this.revision += 1
    return true
  }

  keyboardEdit(edit) {
    this.settlePartial()
    const next = String(edit(this.text))
    if (next === this.text) return false
    this.text = next
    this.revision += 1
    return true
  }

  replaceRecent({ from, to = '', revision, seq }) {
    if (
      Number(revision) !== this.revision
      || !this.range
      || (seq !== undefined && (!Number.isInteger(seq) || seq <= this.sequence))
    ) return false
    const source = String(from || '')
    if (!source) return false
    const recent = this.text.slice(this.range.start, this.range.end)
    const first = recent.indexOf(source)
    if (first < 0 || recent.indexOf(source, first + source.length) >= 0) return false
    const next = String(to || '')
    const absolute = this.range.start + first
    this.text = this.text.slice(0, absolute) + next
      + this.text.slice(absolute + source.length)
    this.range.end += next.length - source.length
    this.pending = ''
    if (seq !== undefined) this.sequence = seq
    this.revision += 1
    return true
  }

  reset(text = '') {
    this.text = String(text)
    this.pending = ''
    this.range = null
    this.revision += 1
  }
}
