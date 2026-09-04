import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRONTEND_TOOL_DEFINITIONS } from '../service/tools/registry.mjs'

const HEALER_PROFILE_URL = new URL('./assistant/healer.md', import.meta.url)

function policyDescription(tool) {
  const description = String(tool.description || tool.title || tool.name).trim()
  return `${description} 当前领域配置为前台执行，用户意图明确时直接调用本工具；不要通过 spawn_thinking 重复提交同一操作。`
}

export function createCockpitFrontendMcpConfiguration({
  frontendMcpUrl = process.env.COCKPIT_FRONTEND_MCP_URL,
} = {}) {
  if (!frontendMcpUrl) throw new Error('Cockpit frontend MCP URL is required')
  return {
    version: 1,
    servers: {
      cockpit: {
        enabled: true,
        url: frontendMcpUrl,
        tools: Object.fromEntries(
          FRONTEND_TOOL_DEFINITIONS.map(tool => [tool.name, {
            enabled: true,
            description: policyDescription(tool),
          }]),
        ),
      },
    },
  }
}

export function writeCockpitFrontendProfileBundle({
  root = process.env.QWAUDIO_CONFIG_DIR,
  frontendMcpUrl = process.env.COCKPIT_FRONTEND_MCP_URL,
} = {}) {
  if (!root) throw new Error('Cockpit frontend profile bundle root is required')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'assistant'), { recursive: true })
  const mcpPath = join(root, 'frontend-mcp.json')
  const profilePath = join(root, 'frontend-profile.json')
  writeFileSync(join(root, 'assistant/healer.md'), readFileSync(HEALER_PROFILE_URL, 'utf8'))
  writeFileSync(
    mcpPath,
    `${JSON.stringify(createCockpitFrontendMcpConfiguration({ frontendMcpUrl }), null, 2)}\n`,
  )
  writeFileSync(
    profilePath,
    `${JSON.stringify({
      version: 1,
      name: 'cockpit-example',
      description: 'A concise, action-oriented foreground voice assistant for the cockpit example.',
      assistant: 'assistant/healer.md',
      toolSources: { mcp: 'frontend-mcp.json' },
    }, null, 2)}\n`,
  )
  return profilePath
}
