import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  emptyFrontendProfile,
  loadFrontendProfile,
  normalizeFrontendProfile,
  resolveFrontendProfileConfiguration,
} from '../src/core/frontend-profile.mjs'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-profile-'))
  mkdirSync(join(directory, 'tools'))
  writeFileSync(join(directory, 'ASSISTANT.md'), '# Assistant\n', 'utf8')
  writeFileSync(join(directory, 'tools', 'mcp.json'), '{}\n', 'utf8')
  writeFileSync(join(directory, 'tools', 'openapi.json'), '{}\n', 'utf8')
  return directory
}

test('uses one inert default when no Frontend Profile is configured', () => {
  assert.deepEqual(loadFrontendProfile({ filePath: '' }), emptyFrontendProfile())
})

test('loads a portable profile and resolves only local bundle references', () => {
  const directory = fixture()
  const filePath = join(directory, 'frontend-profile.json')
  try {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      name: '  Research   Voice  ',
      description: ' Search and reference tools. ',
      assistant: './ASSISTANT.md',
      toolSources: {
        mcp: './tools/mcp.json',
        openapi: './tools/openapi.json',
      },
    }), 'utf8')
    assert.deepEqual(loadFrontendProfile({ filePath }), {
      version: 1,
      configured: true,
      name: 'Research Voice',
      description: 'Search and reference tools.',
      assistantProfilePath: join(directory, 'ASSISTANT.md'),
      frontendMcpConfigPath: join(directory, 'tools', 'mcp.json'),
      frontendOpenApiConfigPath: join(directory, 'tools', 'openapi.json'),
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps explicit environment paths above profile defaults', () => {
  const profile = {
    ...emptyFrontendProfile(),
    configured: true,
    name: 'work',
    description: 'Work profile',
    assistantProfilePath: '/profile/ASSISTANT.md',
    frontendMcpConfigPath: '/profile/mcp.json',
    frontendOpenApiConfigPath: '/profile/openapi.json',
  }
  assert.deepEqual(resolveFrontendProfileConfiguration({
    profile,
    env: {
      QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH: '/explicit/ASSISTANT.md',
      QWEN_AUDIO_FRONTEND_MCP_CONFIG: '/explicit/mcp.json',
    },
    defaultAssistantProfilePath: '/default/ASSISTANT.md',
  }), {
    frontendProfile: {
      configured: true,
      name: 'work',
      description: 'Work profile',
    },
    assistantProfilePath: resolve('/explicit/ASSISTANT.md'),
    frontendMcpConfigPath: '/explicit/mcp.json',
    frontendOpenApiConfigPath: '/profile/openapi.json',
  })
})

test('fails closed for unsupported fields, escapes, and empty manifests', () => {
  const directory = fixture()
  try {
    assert.throws(() => normalizeFrontendProfile({
      version: 1,
      name: 'bad',
      backend: 'qwen',
      assistant: './ASSISTANT.md',
    }, { baseDirectory: directory }), /unsupported fields: backend/)
    assert.throws(() => normalizeFrontendProfile({
      version: 1,
      name: 'escape',
      assistant: '../ASSISTANT.md',
    }, { baseDirectory: directory }), /must stay inside/)
    assert.throws(() => normalizeFrontendProfile({
      version: 1,
      name: 'empty',
    }, { baseDirectory: directory }), /must reference an assistant or tool source/)
    assert.throws(() => normalizeFrontendProfile({
      version: 1,
      name: ['not', 'text'],
      assistant: './ASSISTANT.md',
    }, { baseDirectory: directory }), /name must be a string/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
