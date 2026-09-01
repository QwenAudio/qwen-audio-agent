import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from '../core/config.mjs'
import { canonicalScope, isDirectiveScope } from '../core/memory-scopes.mjs'
import { recentConversationMessages } from '../../../shared/conversation-history.mjs'

const PROMPT_FILE = 'PROMPT.md'
const ASSISTANT_FILE = 'ASSISTANT.md'
const MAX_PROMPT_CHARS = 16000
const MAX_ASSISTANT_CHARS = 4000
const MAX_RECENT_CHARS = 3500

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function normalizeClientContext({
  timeZone,
  locale,
  workingDirectory,
} = {}) {
  let safeTimeZone = clean(timeZone)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone }).format()
  } catch {
    safeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  let safeLocale = clean(locale).slice(0, 35) || 'zh-CN'
  try {
    new Intl.DateTimeFormat(safeLocale).format()
  } catch {
    safeLocale = 'zh-CN'
  }
  const safeWorkingDirectory = String(workingDirectory || '')
    .replaceAll('\0', '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 1024)
  return {
    timeZone: safeTimeZone,
    locale: safeLocale,
    workingDirectory: safeWorkingDirectory || null,
  }
}

export function currentTimeSnapshot({
  timeZone,
  locale,
  now = new Date(),
} = {}) {
  const context = normalizeClientContext({ timeZone, locale })
  return {
    iso_utc: now.toISOString(),
    local_time: new Intl.DateTimeFormat(context.locale, {
      timeZone: context.timeZone,
      dateStyle: 'full',
      timeStyle: 'long',
      hour12: false,
    }).format(now),
    time_zone: context.timeZone,
    locale: context.locale,
  }
}

export function loadFrontendPrompt() {
  const content = readFileSync(
    resolve(config.frontendPromptDir, PROMPT_FILE),
    'utf8',
  ).trim()
  if (!content) throw new Error(`${PROMPT_FILE} must not be empty`)
  return [...content].slice(0, MAX_PROMPT_CHARS).join('')
}

export function loadAssistantProfile() {
  const content = readFileSync(
    config.assistantProfilePath || resolve(config.frontendPromptDir, ASSISTANT_FILE),
    'utf8',
  ).trim()
  if (!content) throw new Error(`${ASSISTANT_FILE} must not be empty`)
  return [...content].slice(0, MAX_ASSISTANT_CHARS).join('')
}

export function resolveAssistantProfile(agentContext = {}) {
  // A trusted host may select a complete profile for one live Session. Client
  // payloads never enter this field directly; the packaged/local file remains
  // the deployment-wide fallback.
  const sessionProfile = String(agentContext.assistantProfile || '').trim()
  if (!sessionProfile) return loadAssistantProfile()
  return [...sessionProfile].slice(0, MAX_ASSISTANT_CHARS).join('')
}

function userPreferencesSection(memories = []) {
  const document = memories.find(memory => (
    isDirectiveScope(clean(memory.scope))
  ))
  if (!document?.content) return ''
  const opening = document.revision
    ? `<user_preferences revision="${clean(document.revision)}">`
    : '<user_preferences>'
  return [
    opening,
    String(document.content).trim(),
    '</user_preferences>',
  ].join('\n')
}

function memorySection(memories = []) {
  const document = memories.find(memory => (
    canonicalScope(clean(memory.scope)) === 'memory'
  ))
  if (!document?.content) return ''
  const opening = document.revision
    ? `<user_memory revision="${clean(document.revision)}">`
    : '<user_memory>'
  return [
    opening,
    String(document.content).trim(),
    '</user_memory>',
  ].join('\n')
}

export function buildRecentConversationContext(messages = []) {
  const candidates = recentConversationMessages(messages)
  const selected = []
  let used = 0
  for (const message of candidates.toReversed()) {
    const content = clean(message.content)
    if (!content) continue
    const inputSummary = (message.inputs || []).map(input => [
      clean(input.ref),
      clean(input.label || input.filename || input.type),
      clean(input.filename),
      clean(input.mime),
    ].filter(Boolean).join(' · ')).filter(Boolean).join('；')
    const base = `${message.role === 'user' ? '用户' : '助手'}: ${content}`
    const line = inputSummary
      ? `${base}（可引用输入：${inputSummary}）`
      : base
    if (selected.length && used + line.length > MAX_RECENT_CHARS) break
    selected.unshift(line)
    used += line.length
  }
  if (!selected.length) return ''
  return [
    '<recent_conversation>',
    ...selected,
    '</recent_conversation>',
  ].join('\n')
}

export function buildFrontendContext({
  client = {},
  memories = [],
} = {}) {
  const normalizedClient = normalizeClientContext(client)
  const runtimeContext = [
    '<runtime_context>',
    'channel=full_duplex_voice',
    `time_zone=${JSON.stringify(normalizedClient.timeZone)}`,
    `locale=${JSON.stringify(normalizedClient.locale)}`,
    ...(normalizedClient.workingDirectory
      ? [`client_working_directory=${JSON.stringify(normalizedClient.workingDirectory)}`]
      : []),
    '</runtime_context>',
  ].join('\n')
  return [
    userPreferencesSection(memories),
    memorySection(memories),
    runtimeContext,
  ].filter(Boolean).join('\n\n')
}
