import { emitKeypressEvents } from 'node:readline'

export function completeTranscript(streamed, final) {
  const streamedText = String(streamed || '').trim()
  const finalText = String(final || '').trim()
  if (!finalText || streamedText.startsWith(finalText)) return streamedText
  return finalText
}

export function createTurnStatusDisplay({
  print,
  maxRememberedTurns = 200,
} = {}) {
  const awaitingAssistant = new Set()
  const turnOrder = []
  const pending = new Map()

  const remember = turnId => {
    const id = String(turnId || '')
    if (!id || awaitingAssistant.has(id)) return
    awaitingAssistant.add(id)
    turnOrder.push(id)
    while (turnOrder.length > maxRememberedTurns) {
      const forgotten = turnOrder.shift()
      awaitingAssistant.delete(forgotten)
      for (const line of pending.get(forgotten) || []) print(line)
      pending.delete(forgotten)
    }
  }

  const release = turnId => {
    const id = String(turnId || '')
    if (!id || !awaitingAssistant.delete(id)) return
    for (const line of pending.get(id) || []) print(line)
    pending.delete(id)
  }

  return {
    begin(turnId) {
      remember(turnId)
    },
    status(event, line) {
      const turnId = String(event?.task?.turnId || '')
      if (!turnId || !awaitingAssistant.has(turnId)) {
        print(line)
        return
      }
      const lines = pending.get(turnId) || []
      lines.push(line)
      pending.set(turnId, lines)
    },
    assistantFinished(turnId) {
      release(turnId)
    },
    reset() {
      for (const turnId of turnOrder) release(turnId)
      turnOrder.length = 0
      awaitingAssistant.clear()
    },
  }
}

export function createTranscriptDisplay({
  onUser,
  onAssistant,
  onUserDelta = () => {},
  onUserDiscard = () => {},
  onAssistantDelta = () => {},
  onReset = () => {},
}) {
  const maxRememberedTurns = 200
  const maxRememberedResponses = 200
  const userDeltas = new Map()
  const assistantDeltas = new Map()
  const completedUserTurns = new Set()
  const completedUserTurnOrder = []
  const completedAssistantResponses = new Set()
  const completedAssistantResponseOrder = []
  const pendingAssistants = new Map()
  const assistantTurns = new Map()

  const completeUserTurn = turnId => {
    if (completedUserTurns.has(turnId)) return
    completedUserTurns.add(turnId)
    completedUserTurnOrder.push(turnId)
    while (completedUserTurnOrder.length > maxRememberedTurns) {
      completedUserTurns.delete(completedUserTurnOrder.shift())
    }
  }

  const flushTurn = turnId => {
    const pending = pendingAssistants.get(turnId) || []
    pendingAssistants.delete(turnId)
    for (const item of pending) onAssistant(item.content, item.event)
    for (const [responseId, content] of assistantDeltas) {
      if (assistantTurns.get(responseId) === turnId) onAssistantDelta(content)
    }
  }

  const completeAssistantResponse = responseId => {
    if (!responseId || completedAssistantResponses.has(responseId)) return
    completedAssistantResponses.add(responseId)
    completedAssistantResponseOrder.push(responseId)
    while (completedAssistantResponseOrder.length > maxRememberedResponses) {
      completedAssistantResponses.delete(completedAssistantResponseOrder.shift())
    }
  }

  return {
    handle(event) {
      if (!event?.type?.startsWith('transcript.')) return false

      if (event.role === 'user' && event.type === 'transcript.delta') {
        const turnId = String(event.turnId || '')
        const incoming = String(event.content || '')
        const content = event.replace === true
          ? incoming
          : `${userDeltas.get(turnId) || ''}${incoming}`
        if (turnId) userDeltas.set(turnId, content)
        if (content) onUserDelta(content)
        return true
      }

      if (event.role === 'user' && event.type === 'transcript.final') {
        const turnId = String(event.turnId || '')
        const content = completeTranscript(
          userDeltas.get(turnId),
          String(event.content || '').replace(/\s+/g, ' '),
        )
        userDeltas.delete(turnId)
        if (content) onUser(content, event)
        if (turnId) {
          completeUserTurn(turnId)
          flushTurn(turnId)
        }
        return true
      }

      if (event.role === 'user' && event.type === 'transcript.discard') {
        const turnId = String(event.turnId || '')
        userDeltas.delete(turnId)
        onUserDiscard(turnId, event)
        if (turnId) {
          completeUserTurn(turnId)
          flushTurn(turnId)
        }
        return true
      }

      if (event.role !== 'assistant') return true
      const responseId = String(event.responseId || '')
      if (responseId && completedAssistantResponses.has(responseId)) return true
      if (event.type === 'transcript.delta') {
        const previous = assistantDeltas.get(responseId) || ''
        const content = previous + String(event.content || '')
        assistantDeltas.set(responseId, content)
        const turnId = String(event.turnId || '')
        if (turnId) assistantTurns.set(responseId, turnId)
        const waitsForUser = (
          event.origin === 'model'
          && turnId
          && !completedUserTurns.has(turnId)
        )
        if (!waitsForUser && content) onAssistantDelta(content)
        return true
      }
      if (event.type !== 'transcript.final') return true

      const content = completeTranscript(
        assistantDeltas.get(responseId),
        event.content,
      )
      assistantDeltas.delete(responseId)
      assistantTurns.delete(responseId)
      completeAssistantResponse(responseId)
      if (!content) return true

      const turnId = String(event.turnId || '')
      const waitsForUser = (
        event.origin === 'model'
        && turnId
        && !completedUserTurns.has(turnId)
      )
      if (!waitsForUser) {
        onAssistant(content, event)
        return true
      }
      const pending = pendingAssistants.get(turnId) || []
      pending.push({ content, event })
      pendingAssistants.set(turnId, pending)
      return true
    },
    reset() {
      userDeltas.clear()
      assistantDeltas.clear()
      completedUserTurns.clear()
      completedUserTurnOrder.length = 0
      completedAssistantResponses.clear()
      completedAssistantResponseOrder.length = 0
      pendingAssistants.clear()
      assistantTurns.clear()
      onReset()
    },
  }
}

export function createTerminalTranscriptRenderer({
  stdout = process.stdout,
} = {}) {
  let active = null
  let previewRows = 0
  const pendingLines = []
  const interactive = Boolean(stdout.isTTY)
  const stripAnsi = text => String(text || '').replace(/\u001b\[[0-9;]*m/g, '')
  const characterWidth = character => {
    const codePoint = character.codePointAt(0) || 0
    if (
      codePoint === 0
      || codePoint < 32
      || (codePoint >= 0x7f && codePoint < 0xa0)
      || (codePoint >= 0x300 && codePoint <= 0x36f)
      || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
      || codePoint === 0x200d
    ) return 0
    return codePoint <= 0x7e ? 1 : 2
  }
  const displayWidth = text => Array.from(stripAnsi(text))
    .reduce((width, character) => width + characterWidth(character), 0)
  const previewLines = (prefix, content) => {
    const columns = Math.max(8, Number(stdout.columns) || 80)
    // Leave one terminal column unused to avoid exact-width auto-wrap, whose
    // cursor behavior differs between terminals.
    const maxWidth = Math.max(7, columns - 1)
    const firstPrefix = `${prefix} `
    const prefixWidth = displayWidth(firstPrefix)
    const continuation = ' '.repeat(Math.min(prefixWidth, maxWidth - 2))
    const continuationWidth = displayWidth(continuation)
    const points = Array.from(String(content || '').replace(/\s+/g, ' '))
    const lines = []
    let line = firstPrefix
    let width = prefixWidth
    for (const point of points) {
      const pointWidth = characterWidth(point)
      const minimumWidth = lines.length === 0 ? prefixWidth : continuationWidth
      if (width > minimumWidth && width + pointWidth > maxWidth) {
        lines.push(line)
        line = continuation
        width = continuationWidth
      }
      line += point
      width += pointWidth
    }
    lines.push(line)
    return lines
  }
  const clearPreview = () => {
    if (!interactive || previewRows === 0) return
    stdout.write('\r\u001b[2K')
    for (let row = 1; row < previewRows; row += 1) {
      stdout.write('\u001b[1A\r\u001b[2K')
    }
    previewRows = 0
  }
  const redrawPreview = () => {
    if (!interactive || active?.kind !== 'preview') return
    clearPreview()
    const lines = previewLines(active.prefix, active.content)
    stdout.write(lines.join('\n'))
    previewRows = lines.length
  }
  const flushPending = () => {
    while (pendingLines.length) stdout.write(`${pendingLines.shift()}\n`)
  }
  const closeActiveStream = () => {
    if (active?.kind !== 'stream') return
    stdout.write('\n')
    active = null
    flushPending()
  }
  return {
    update(prefix, content) {
      // A provisional user ASR snapshot can arrive while the assistant is
      // still speaking (for example from residual playback). Do not let that
      // ephemeral preview split the assistant's cumulative transcript into
      // two terminal lines. A real interruption clears playback first, and a
      // final user transcript will still close the stream in finish().
      if (active?.kind === 'stream') return
      active = {
        kind: 'preview',
        prefix: String(prefix || ''),
        content: String(content || ''),
      }
      redrawPreview()
    },
    stream(prefix, content) {
      const nextPrefix = String(prefix || '')
      const nextContent = String(content || '')
      if (active?.kind === 'preview') clearPreview()
      if (active?.kind !== 'stream' || active.prefix !== nextPrefix) {
        if (active?.kind === 'stream') closeActiveStream()
        stdout.write(`${nextPrefix} ${nextContent}`)
      } else if (nextContent.startsWith(active.content)) {
        stdout.write(nextContent.slice(active.content.length))
      } else if (!active.content.startsWith(nextContent)) {
        stdout.write(`\n${nextPrefix} ${nextContent}`)
      }
      active = { kind: 'stream', prefix: nextPrefix, content: nextContent }
    },
    finish(prefix, content) {
      const nextPrefix = String(prefix || '')
      const nextContent = String(content || '')
      if (active?.kind === 'preview') {
        clearPreview()
        stdout.write(`${nextPrefix} ${nextContent}\n`)
      } else if (active?.kind === 'stream' && active.prefix === nextPrefix) {
        const complete = completeTranscript(active.content, nextContent)
        if (complete.startsWith(active.content)) {
          stdout.write(`${complete.slice(active.content.length)}\n`)
        } else if (active.content.startsWith(complete)) {
          stdout.write('\n')
        } else {
          stdout.write(`\n${nextPrefix} ${complete}\n`)
        }
      } else {
        if (active?.kind === 'stream') stdout.write('\n')
        stdout.write(`${nextPrefix} ${nextContent}\n`)
      }
      active = null
      flushPending()
    },
    print(line) {
      if (active?.kind === 'stream') {
        pendingLines.push(String(line))
        return
      }
      if (active?.kind === 'preview') clearPreview()
      stdout.write(`${line}\n`)
      redrawPreview()
    },
    discardPreview() {
      if (active?.kind !== 'preview') return
      clearPreview()
      active = null
      flushPending()
    },
    cancel() {
      if (active?.kind === 'preview') clearPreview()
      else if (active?.kind === 'stream') stdout.write('\n')
      active = null
      flushPending()
    },
  }
}

export function createPersistentTerminalRenderer({
  stdin = process.stdin,
  stdout = process.stdout,
  prompt = '你 > ',
  onLine = async () => {},
  onPaste = async value => value,
  onChange = () => {},
  onClose = () => {},
} = {}) {
  const entries = []
  let activePreview = ''
  let draft = []
  let cursor = 0
  let scrollOffset = 0
  let pasteBuffer = null
  let pasteQueue = Promise.resolve()
  const pendingPastes = []
  let status = 'Gateway 连接中 · 麦克风准备中'
  let closed = false
  let closeRequested = false
  let lineQueue = Promise.resolve()
  const maxHistoryEntries = 2000
  const stripAnsi = text => String(text || '').replace(/\u001b\[[0-9;]*m/g, '')
  const characterWidth = character => {
    const point = character.codePointAt(0) || 0
    if (
      point === 0
      || point < 32
      || (point >= 0x7f && point < 0xa0)
      || (point >= 0x300 && point <= 0x36f)
      || (point >= 0xfe00 && point <= 0xfe0f)
      || point === 0x200d
    ) return 0
    return point <= 0x7e ? 1 : 2
  }
  const displayWidth = text => Array.from(stripAnsi(text))
    .reduce((width, character) => width + characterWidth(character), 0)
  const truncate = (text, maxWidth) => {
    let result = ''
    let width = 0
    for (const character of Array.from(stripAnsi(text))) {
      const next = characterWidth(character)
      if (width + next > maxWidth) break
      result += character
      width += next
    }
    return result
  }
  const wrap = (text, maxWidth) => {
    const lines = []
    for (const sourceLine of stripAnsi(text).split('\n')) {
      let line = ''
      let width = 0
      for (const character of Array.from(sourceLine)) {
        const next = characterWidth(character)
        if (line && width + next > maxWidth) {
          lines.push(line)
          line = ''
          width = 0
        }
        line += character
        width += next
      }
      lines.push(line)
    }
    return lines
  }
  const inputViewport = maxWidth => {
    let start = cursor
    let width = 0
    while (start > 0) {
      const next = characterWidth(draft[start - 1])
      if (width + next > maxWidth) break
      start -= 1
      width += next
    }
    let end = cursor
    let afterWidth = width
    while (end < draft.length) {
      const next = characterWidth(draft[end])
      if (afterWidth + next > maxWidth) break
      afterWidth += next
      end += 1
    }
    return {
      content: draft.slice(start, end).join(''),
      cursorColumn: draft.slice(start, cursor)
        .reduce((sum, character) => sum + characterWidth(character), 0),
    }
  }
  const redraw = () => {
    if (closed) return
    const columns = Math.max(20, Number(stdout.columns) || 80)
    // Avoid writing into the last terminal column. Some terminals immediately
    // auto-wrap an exact-width line and would shift the fixed composer down.
    const contentWidth = columns - 1
    const rows = Math.max(8, Number(stdout.rows) || 24)
    const conversationRows = rows - 4
    const source = activePreview
      ? [...entries, activePreview]
      : entries
    const allLines = source.flatMap(entry => wrap(entry, contentWidth))
    const maxOffset = Math.max(0, allLines.length - conversationRows)
    scrollOffset = Math.min(scrollOffset, maxOffset)
    const end = Math.max(0, allLines.length - scrollOffset)
    const start = Math.max(0, end - conversationRows)
    const visible = allLines.slice(start, end)
    while (visible.length < conversationRows) visible.unshift('')
    const separator = '─'.repeat(contentWidth)
    const input = inputViewport(Math.max(
      1,
      contentWidth - displayWidth(prompt),
    ))
    const visibleStatus = scrollOffset > 0
      ? `${status} · 已上翻 ${scrollOffset} 行`
      : status
    const footer = [
      separator,
      truncate(visibleStatus, contentWidth),
      `${prompt}${input.content}`,
      truncate(
        'Enter 发送 · /help 命令 · PgUp/PgDn 滚动 · Ctrl-C 退出',
        contentWidth,
      ),
    ]
    const screen = [...visible, ...footer]
      .map(value => `\u001b[2K${value}`)
      .join('\n')
    const inputRow = conversationRows + 3
    const inputColumn = Math.min(
      contentWidth,
      displayWidth(prompt) + input.cursorColumn + 1,
    )
    stdout.write(
      `\u001b[?25l\u001b[H${screen}`
      + `\u001b[${inputRow};${inputColumn}H\u001b[?25h`,
    )
  }
  const append = value => {
    const content = String(value || '').replace(/\n+$/, '')
    if (content) entries.push(content)
    if (entries.length > maxHistoryEntries) {
      entries.splice(0, entries.length - maxHistoryEntries)
    }
    scrollOffset = 0
    redraw()
  }
  const renderer = {
    update(prefix, content) {
      activePreview = `${prefix} ${content}`
      scrollOffset = 0
      redraw()
    },
    stream(prefix, content) {
      activePreview = `${prefix} ${content}`
      scrollOffset = 0
      redraw()
    },
    finish(prefix, content) {
      activePreview = ''
      append(`${prefix} ${content}`)
    },
    print(value) {
      append(value)
    },
    setStatus(value) {
      status = String(value || '')
      redraw()
    },
    discardPreview() {
      if (!activePreview) return
      activePreview = ''
      redraw()
    },
    cancel() {
      if (!activePreview) return
      activePreview = ''
      redraw()
    },
    close() {
      if (closed) return
      closed = true
      stdin.off('keypress', handleKeypress)
      stdout.off?.('resize', redraw)
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false)
      }
      stdout.write('\u001b[?2004l\u001b[?25h\u001b[?1049l')
    },
  }
  const submit = value => {
    lineQueue = lineQueue
      .then(() => onLine(value))
      .catch(error => renderer.print(`[错误] ${error.message}`))
      .finally(redraw)
  }
  const requestClose = () => {
    if (closed || closeRequested) return
    closeRequested = true
    onClose()
  }
  const insert = value => {
    const inserted = Array.from(value)
    const start = cursor
    draft.splice(cursor, 0, ...inserted)
    cursor += inserted.length
    return { start, length: inserted.length }
  }
  const resolvePaste = (value, insertion) => {
    pendingPastes.push(insertion)
    pasteQueue = pasteQueue
      .then(() => onPaste(value))
      .then(result => {
        if (closed) return
        const replacement = typeof result === 'string'
          ? result
          : String(result?.text ?? value)
        const original = draft
          .slice(insertion.start, insertion.start + insertion.length)
          .join('')
        if (original !== value) return
        const characters = Array.from(replacement)
        draft.splice(insertion.start, insertion.length, ...characters)
        const delta = characters.length - insertion.length
        for (const pending of pendingPastes) {
          if (pending !== insertion && pending.start > insertion.start) {
            pending.start += delta
          }
        }
        if (cursor >= insertion.start + insertion.length) cursor += delta
        else if (cursor > insertion.start) cursor = insertion.start + characters.length
        result?.apply?.()
        onChange(draft.join(''))
        redraw()
      })
      .catch(error => renderer.print(`[附件错误] ${error.message}`))
      .finally(() => {
        const index = pendingPastes.indexOf(insertion)
        if (index >= 0) pendingPastes.splice(index, 1)
      })
  }
  const handleKeypress = (value, key = {}) => {
    if (closed) return
    if (key.name === 'paste-start') {
      pasteBuffer = ''
      return
    }
    if (key.name === 'paste-end') {
      const pasted = String(pasteBuffer || '').replace(/[\r\n]+/g, ' ')
      pasteBuffer = null
      if (!pasted) return
      const insertion = insert(pasted)
      redraw()
      resolvePaste(pasted, insertion)
      return
    }
    if (pasteBuffer !== null) {
      pasteBuffer += value || ''
      return
    }
    if (key.ctrl && key.name === 'c') {
      requestClose()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      const submitted = draft.join('')
      draft = []
      cursor = 0
      scrollOffset = 0
      redraw()
      submit(submitted)
      return
    }
    let changed = false
    if (key.name === 'backspace') {
      if (cursor > 0) {
        draft.splice(--cursor, 1)
        changed = true
      }
    } else if (key.name === 'delete') {
      if (cursor < draft.length) {
        draft.splice(cursor, 1)
        changed = true
      }
    } else if (key.name === 'left') {
      cursor = Math.max(0, cursor - 1)
    } else if (key.name === 'right') {
      cursor = Math.min(draft.length, cursor + 1)
    } else if (key.name === 'home') {
      cursor = 0
    } else if (key.name === 'end') {
      cursor = draft.length
    } else if (key.name === 'pageup') {
      scrollOffset += Math.max(1, (Number(stdout.rows) || 24) - 5)
    } else if (key.name === 'pagedown') {
      scrollOffset = Math.max(0, scrollOffset - Math.max(
        1,
        (Number(stdout.rows) || 24) - 5,
      ))
    } else if (key.ctrl || key.meta || key.name === 'escape') {
      return
    } else if (value && !/^[\u0000-\u001f\u007f]$/.test(value)) {
      insert(value)
      changed = true
    } else return
    if (changed) onChange(draft.join(''))
    redraw()
  }
  emitKeypressEvents(stdin)
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true)
  }
  stdin.on('keypress', handleKeypress)
  stdout.on?.('resize', redraw)
  stdout.write('\u001b[?1049h\u001b[?2004h')
  redraw()
  return renderer
}
