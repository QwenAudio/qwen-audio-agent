import { FrontendRetrievalRuntime } from '../frontend-retrieval-runtime.mjs'
import { createWebSearchProvider } from './factory.mjs'
import { resolveWebSearchConfiguration } from '../../../../../shared/web-search-configuration.mjs'

/**
 * Public, side-effect-free composition for a Gateway or standalone Agent.
 * Reuses the same citations, provider timeouts and SSRF-safe URL fetcher as the
 * foreground. Does not load .env files, initialize Gateway state, or connect
 * until search()/fetchUrl() is called. The caller owns tool schemas and policy.
 */
export function createWebRetrieval({
  env = process.env,
  searchProvider,
  urlFetcher,
  searchTimeoutMs,
} = {}) {
  const config = resolveWebSearchConfiguration(env)
  return new FrontendRetrievalRuntime({
    searchProvider: searchProvider === undefined
      ? createWebSearchProvider({
          webSearchProvider: config.provider,
          webSearchMcpUrl: config.mcpUrl,
          webSearchMcpToken: config.mcpToken,
          webSearchMcpTool: config.mcpTool,
        })
      : searchProvider,
    ...(urlFetcher === undefined ? {} : { urlFetcher }),
    ...(searchTimeoutMs === undefined ? {} : { searchTimeoutMs }),
  })
}
