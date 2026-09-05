export const SUPPORTED_MEMORY_PROVIDERS = Object.freeze(['markdown', 'voicemem'])

export function normalizeMemoryProviderSelection(value) {
  const selected = String(value || 'markdown').trim().toLowerCase()
  if (SUPPORTED_MEMORY_PROVIDERS.includes(selected)) return selected
  throw new Error(
    `不支持的记忆 Provider：${selected}`
    + `（可选 ${SUPPORTED_MEMORY_PROVIDERS.join('、')}）`,
  )
}
