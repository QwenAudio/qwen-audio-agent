// Share MCP pagination between general tools and the search provider. All pages
// consume the caller's original deadline; a broken server cannot renew it.
export async function listMcpTools(client, { signal, maxPages = 100, maxTools = 10_000 } = {}) {
  const tools = []
  const cursors = new Set()
  let cursor
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted()
    const result = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal })
    if (!Array.isArray(result?.tools)) throw new Error('Invalid MCP tools/list result.')
    tools.push(...result.tools)
    if (tools.length > maxTools) throw new Error('MCP tool discovery exceeds the tool limit.')
    if (result.nextCursor === undefined) return tools
    if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) {
      throw new Error('Invalid or repeated MCP tool discovery cursor.')
    }
    cursor = result.nextCursor
    cursors.add(cursor)
  }
  throw new Error('MCP tool discovery exceeds the page limit.')
}
