import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  loadFrontendMcpConfiguration,
  normalizeFrontendMcpConfiguration,
} from '../src/providers/mcp/frontend-mcp-config.mjs'

function configuration(overrides = {}) {
  return {
    version: 1,
    servers: {
      documents: {
        enabled: true,
        url: 'https://mcp.example.test/api',
        headers: { authorization: '${MCP_TOKEN}' },
        tools: {
          search: {
            enabled: true,
          },
        },
      },
    },
    ...overrides,
  }
}

test('loads no frontend MCP servers when no config path is set', () => {
  assert.deepEqual(loadFrontendMcpConfiguration({ filePath: '' }), {
    version: 1,
    servers: [],
  })
})

test('normalizes explicit server and tool policies', () => {
  const normalized = normalizeFrontendMcpConfiguration(configuration(), {
    env: { MCP_TOKEN: 'secret-token' },
  })
  assert.deepEqual(normalized, {
    version: 1,
    servers: [{
      key: 'documents',
      enabled: true,
      connectTimeoutMs: 8_000,
      transport: {
        type: 'streamable-http',
        url: 'https://mcp.example.test/api',
        headers: { authorization: 'secret-token' },
      },
      tools: {
        search: {
          enabled: true,
          timeoutMs: 8_000,
          maxResultBytes: 32 * 1024,
          maxCallsPerTurn: 2,
        },
      },
    }],
  })
})

test('resolves a complete MCP endpoint from the launching environment', () => {
  const normalized = normalizeFrontendMcpConfiguration(configuration({
    servers: {
      cockpit: {
        enabled: true,
        url: '${COCKPIT_MCP_URL}',
        tools: {
          weather: { enabled: true },
        },
      },
    },
  }), {
    env: { COCKPIT_MCP_URL: 'http://127.0.0.1:3010/mcp/frontend' },
  })
  assert.equal(
    normalized.servers[0].transport.url,
    'http://127.0.0.1:3010/mcp/frontend',
  )
})

test('loads and validates a versioned frontend MCP JSON file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-mcp-'))
  const filePath = join(directory, 'mcp.json')
  try {
    writeFileSync(filePath, JSON.stringify(configuration()), 'utf8')
    const loaded = loadFrontendMcpConfiguration({
      filePath,
      env: { MCP_TOKEN: 'from-env' },
    })
    assert.equal(loaded.servers[0].transport.headers.authorization, 'from-env')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('fails closed for unsafe endpoints and missing secrets', () => {
  assert.throws(
    () => normalizeFrontendMcpConfiguration(configuration(), { env: {} }),
    /environment variable is missing: MCP_TOKEN/,
  )
  assert.throws(
    () => normalizeFrontendMcpConfiguration(configuration({
      servers: {
        local: {
          enabled: true,
          url: 'http://127.0.0.1:9000/mcp',
          headers: { authorization: 'secret' },
          tools: {},
        },
      },
    })),
    /local HTTP cannot carry headers/,
  )
  assert.throws(
    () => normalizeFrontendMcpConfiguration(configuration({
      servers: {
        remote: {
          enabled: true,
          url: 'http://mcp.example.test/api',
          tools: {},
        },
      },
    })),
    /Remote Frontend MCP requires HTTPS/,
  )
})

test('enables selected tools without classifying reads and writes', () => {
  const normalized = normalizeFrontendMcpConfiguration(configuration({
    servers: {
      actions: {
        enabled: true,
        url: 'https://mcp.example.test/api',
        tools: {
          create_issue: {
            enabled: true,
          },
        },
      },
    },
  }))
  assert.deepEqual(normalized.servers[0].tools.create_issue, {
    enabled: true,
    timeoutMs: 8_000,
    maxResultBytes: 32 * 1024,
    maxCallsPerTurn: 2,
  })
  assert.throws(
    () => normalizeFrontendMcpConfiguration(configuration({
      servers: {
        ambiguous: {
          enabled: true,
          url: 'https://mcp.example.test/api',
          tools: { action: { enabled: true, approval: 'required' } },
        },
      },
    })),
    /does not define readOnly or approval/,
  )
  assert.throws(
    () => normalizeFrontendMcpConfiguration(configuration({
      servers: {
        read_only: {
          enabled: true,
          url: 'https://mcp.example.test/api',
          tools: {
            search: {
              enabled: true,
              readOnly: true,
            },
          },
        },
      },
    })),
    /does not define readOnly or approval/,
  )
})

test('rejects unsupported versions and out-of-range policies', () => {
  assert.throws(
    () => normalizeFrontendMcpConfiguration({ version: 2 }),
    /version must be 1/,
  )
  assert.throws(
    () => normalizeFrontendMcpConfiguration(configuration({
      servers: {
        invalid: {
          enabled: true,
          url: 'https://mcp.example.test/api',
          tools: {
            search: {
              enabled: true,
              timeoutMs: 31_000,
            },
          },
        },
      },
    })),
    /must be 100-30000/,
  )
})
