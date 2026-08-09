export function browserTtsSupported(scope = globalThis) {
  return Boolean(scope?.speechSynthesis && scope?.SpeechSynthesisUtterance)
}

export function preferredChineseVoice(voices = []) {
  const scored = voices.map((voice, index) => {
    const language = String(voice.lang || '').toLowerCase()
    let score = 0
    if (language === 'zh-cn' || language === 'zh-hans-cn') score += 40
    else if (language.startsWith('zh')) score += 30
    if (voice.localService) score += 4
    if (voice.default) score += 2
    return { voice, score, index }
  })
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  return scored[0]?.voice || null
}
