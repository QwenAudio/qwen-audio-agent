const PROVIDER_KEY = /^[a-z0-9][a-z0-9-]*$/

/**
 * Internal Web Search port. Adapters return:
 * { results: [{ title, url, snippet?, source?, publishedAt? }] }.
 * Vendor transport fields must be projected before crossing this boundary.
 */
export function validateWebSearchProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Web Search Provider 必须是对象')
  }
  for (const method of ['describe', 'isConfigured', 'search']) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`Web Search Provider 缺少 ${method}()`)
    }
  }
  const description = provider.describe()
  if (
    !description
    || typeof description !== 'object'
    || !PROVIDER_KEY.test(String(description.key || ''))
    || !String(description.label || '').trim()
  ) {
    throw new Error('Web Search Provider describe() 返回无效')
  }
  if (typeof provider.isConfigured() !== 'boolean') {
    throw new Error('Web Search Provider isConfigured() 必须返回布尔值')
  }
  return provider
}
