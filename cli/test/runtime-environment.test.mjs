import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  loadRuntimeEnvironment,
  requireDashScopeCredential,
  requireRealtimeFrontendConfiguration,
  userConfigDirectory,
} from '../../shared/runtime-environment.mjs'

function fixture() {
  const base = mkdtempSync(resolve(tmpdir(), 'qwaudio-config-'))
  const root = resolve(base, 'app')
  const homeDirectory = resolve(base, 'home')
  mkdirSync(root, { recursive: true })
  mkdirSync(homeDirectory, { recursive: true })
  const frontendAgentConfig = resolve(root, 'config/frontend-agent')
  mkdirSync(frontendAgentConfig, { recursive: true })
  writeFileSync(
    resolve(frontendAgentConfig, 'ASSISTANT.md'),
    '# Assistant Profile\n\n## Identity\n\n你默认叫测试助手。\n',
  )
  const codeBuddyConfig = resolve(
    root,
    'config/codebuddy/workspace/.codebuddy',
  )
  mkdirSync(codeBuddyConfig, { recursive: true })
  writeFileSync(resolve(codeBuddyConfig, 'models.json'), JSON.stringify({
    models: [{ id: 'qwen3.7-max', name: 'Qwen 3.7 Max' }],
    availableModels: ['qwen3.7-max'],
  }))
  return { base, root, homeDirectory }
}

function assertPrivateMode(filePath) {
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }
}

test('loads setup configuration without creating or changing user files', () => {
  const target = fixture()
  writeFileSync(resolve(target.root, '.env'), [
    'AGENT_PROTOCOL=codex',
    'CODEX_PATH=/tools/codex',
  ].join('\n'))
  const env = {}
  const result = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env,
    readOnly: true,
  })
  assert.equal(env.AGENT_PROTOCOL, 'codex')
  assert.equal(env.CODEX_PATH, '/tools/codex')
  assert.equal(existsSync(result.configDirectory), false)
  assert.equal(existsSync(result.configPath), false)
  assert.equal(env.CODEX_WORKSPACE, undefined)
  assert.equal(env.QWEN_AUDIO_AGENT_AUTH_SECRET, undefined)
})

test('loads environment, project and user config in documented priority order', () => {
  const target = fixture()
  const configDirectory = resolve(target.homeDirectory, '.config/qwaudio')
  mkdirSync(configDirectory, { recursive: true })
  writeFileSync(resolve(configDirectory, 'config.env'), [
    'DASHSCOPE_API_KEY=user-key',
    'AGENT_PROTOCOL=openclaw',
  ].join('\n'))
  writeFileSync(resolve(target.root, '.env'), [
    'DASHSCOPE_API_KEY=project-key',
    'OPENCODE_BASE_URL=http://127.0.0.1:5000',
  ].join('\n'))
  const env = { DASHSCOPE_API_KEY: 'process-key' }

  loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env,
  })

  assert.equal(env.DASHSCOPE_API_KEY, 'process-key')
  assert.equal(env.OPENCODE_BASE_URL, 'http://127.0.0.1:5000')
  assert.equal(env.AGENT_PROTOCOL, 'openclaw')
})

test('generates and reuses a private stable local identity secret', () => {
  const target = fixture()
  const first = {}
  const result = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: first,
  })
  assert.equal(result.generatedSecret, true)
  assert.equal(first.QWEN_AUDIO_AGENT_AUTH_SECRET.length, 64)
  assertPrivateMode(result.statePath)

  const second = {}
  loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: second,
  })
  assert.equal(
    second.QWEN_AUDIO_AGENT_AUTH_SECRET,
    first.QWEN_AUDIO_AGENT_AUTH_SECRET,
  )
  assert.match(readFileSync(result.statePath, 'utf8'), /AUTH_SECRET=/)
  const configContent = readFileSync(result.configPath, 'utf8')
  assert.match(configContent, /DASHSCOPE_API_KEY=/)
  assert.match(
    configContent,
    /QWEN_AUDIO_REALTIME_PROVIDER=dashscope/,
  )
  assert.match(
    configContent,
    /SPEECH_TO_SPEECH_REALTIME_URL=ws:\/\/127\.0\.0\.1:8765\/v1\/realtime/,
  )
  assert.doesNotMatch(configContent, /S2S_REALTIME_URL=/)
  assertPrivateMode(result.configPath)
  assert.match(readFileSync(result.userModelPath, 'utf8'), /^# USER/m)
  assertPrivateMode(result.userModelPath)
  assert.match(readFileSync(result.assistantProfilePath, 'utf8'), /测试助手/)
  assertPrivateMode(result.assistantProfilePath)
})

test('reuses the persisted secret when the environment provides an empty value', () => {
  const target = fixture()
  const first = {}
  loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: first,
  })

  const second = { QWEN_AUDIO_AGENT_AUTH_SECRET: '' }
  const result = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: second,
  })

  assert.equal(second.QWEN_AUDIO_AGENT_AUTH_SECRET, first.QWEN_AUDIO_AGENT_AUTH_SECRET)
  assert.equal(result.generatedSecret, false)
})

test('does not overwrite an existing user model', () => {
  const target = fixture()
  const configDirectory = resolve(target.homeDirectory, '.config/qwaudio')
  mkdirSync(configDirectory, { recursive: true })
  const userModelPath = resolve(configDirectory, 'USER.md')
  writeFileSync(userModelPath, '# USER\n\n- 称呼：老大\n')

  const result = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: {},
    generateSecret: false,
  })

  assert.equal(result.userModelPath, userModelPath)
  assert.equal(readFileSync(userModelPath, 'utf8'), '# USER\n\n- 称呼：老大\n')
  assertPrivateMode(userModelPath)
})

test('copies the assistant profile template once and preserves user customization', () => {
  const target = fixture()
  const first = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: {},
    generateSecret: false,
  })
  assert.match(readFileSync(first.assistantProfilePath, 'utf8'), /测试助手/)

  writeFileSync(
    first.assistantProfilePath,
    '# Assistant Profile\n\n## Identity\n\n你叫小舟。\n',
  )
  const second = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: {},
    generateSecret: false,
  })

  assert.equal(second.assistantProfilePath, first.assistantProfilePath)
  assert.match(readFileSync(second.assistantProfilePath, 'utf8'), /你叫小舟/)
  assert.doesNotMatch(readFileSync(second.assistantProfilePath, 'utf8'), /测试助手/)
  assertPrivateMode(second.assistantProfilePath)
})

test('supports an explicit cross-platform user config directory', () => {
  const directory = resolve('/tmp/qwaudio-custom')
  assert.equal(
    userConfigDirectory({
      QWAUDIO_CONFIG_DIR: directory,
    }, '/unused'),
    directory,
  )
})

test('keeps managed backend data outside the installation directory', () => {
  const target = fixture()
  const env = {}
  const result = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env,
    generateSecret: false,
  })

  assert.equal(
    result.openCodeWorkspace,
    resolve(result.configDirectory, 'workspaces/opencode'),
  )
  assert.equal(
    result.openClawWorkspace,
    resolve(result.configDirectory, 'workspaces/openclaw'),
  )
  assert.equal(
    result.qoderWorkspace,
    resolve(result.configDirectory, 'workspaces/qoder'),
  )
  assert.equal(
    result.qwenCodeWorkspace,
    resolve(result.configDirectory, 'workspaces/qwen'),
  )
  assert.equal(
    result.kimiWorkspace,
    resolve(result.configDirectory, 'workspaces/kimi'),
  )
  assert.equal(
    result.hermesWorkspace,
    resolve(result.configDirectory, 'workspaces/hermes'),
  )
  assert.equal(
    result.codeBuddyWorkspace,
    resolve(result.configDirectory, 'workspaces/codebuddy'),
  )
  assert.equal(
    result.codexWorkspace,
    resolve(result.configDirectory, 'workspaces/codex'),
  )
  assert.equal(
    result.claudeWorkspace,
    resolve(result.configDirectory, 'workspaces/claude'),
  )
  assert.equal(
    result.piWorkspace,
    resolve(result.configDirectory, 'workspaces/pi'),
  )
  assert.equal(
    result.acpWorkspace,
    resolve(result.configDirectory, 'workspaces/acp'),
  )
  assert.equal(
    result.openClawStateDirectory,
    resolve(result.configDirectory, 'backends/openclaw/state'),
  )
  assert.equal(env.OPENCODE_WORKSPACE, result.openCodeWorkspace)
  assert.equal(
    env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE,
    result.openClawWorkspace,
  )
  assert.equal(
    env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR,
    result.openClawStateDirectory,
  )
  assert.equal(env.OPENCLAW_STATE_DIR, undefined)
  assert.equal(env.QODER_WORKSPACE, result.qoderWorkspace)
  assert.equal(env.QWEN_CODE_WORKSPACE, result.qwenCodeWorkspace)
  assert.equal(env.KIMI_WORKSPACE, result.kimiWorkspace)
  assert.equal(env.HERMES_WORKSPACE, result.hermesWorkspace)
  assert.equal(env.CODEBUDDY_WORKSPACE, result.codeBuddyWorkspace)
  assert.equal(env.CODEX_WORKSPACE, result.codexWorkspace)
  assert.equal(env.CLAUDE_WORKSPACE, result.claudeWorkspace)
  assert.equal(env.PI_WORKSPACE, result.piWorkspace)
  assert.equal(env.ACP_WORKSPACE, result.acpWorkspace)
  assert.equal(
    existsSync(resolve(
      result.codeBuddyWorkspace,
      '.codebuddy/models.json',
    )),
    false,
  )
  assert.equal(
    existsSync(resolve(result.openCodeWorkspace, 'AGENTS.md')),
    false,
  )
})

test('keeps the generated CodeBuddy model aligned with backend settings', () => {
  const target = fixture()
  const env = {
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'alibaba-cn/qwen3.7-plus',
  }
  const first = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env,
    generateSecret: false,
  })
  const modelPath = resolve(
    first.codeBuddyWorkspace,
    '.codebuddy/models.json',
  )
  assert.deepEqual(JSON.parse(readFileSync(modelPath, 'utf8')), {
    models: [{ id: 'qwen3.7-plus', name: 'qwen3.7-plus' }],
    availableModels: ['qwen3.7-plus'],
  })

  loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: { QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max' },
    generateSecret: false,
  })
  assert.deepEqual(JSON.parse(readFileSync(modelPath, 'utf8')), {
    models: [{ id: 'qwen3.7-max', name: 'Qwen 3.7 Max' }],
    availableModels: ['qwen3.7-max'],
  })
})

test('removes only a generated CodeBuddy override when no model is configured', () => {
  const target = fixture()
  const first = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: { QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-plus' },
    generateSecret: false,
  })
  const modelPath = resolve(
    first.codeBuddyWorkspace,
    '.codebuddy/models.json',
  )
  assert.equal(existsSync(modelPath), true)

  loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: {},
    generateSecret: false,
  })
  assert.equal(existsSync(modelPath), false)
})

test('preserves a user-edited CodeBuddy model configuration', () => {
  const target = fixture()
  const env = {
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-plus',
  }
  const first = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env,
    generateSecret: false,
  })
  const modelPath = resolve(
    first.codeBuddyWorkspace,
    '.codebuddy/models.json',
  )
  const customized = `${JSON.stringify({
    models: [{ id: 'custom-model', url: 'https://example.com/v1' }],
  }, null, 2)}\n`
  writeFileSync(modelPath, customized)

  loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: {},
    generateSecret: false,
  })
  assert.equal(readFileSync(modelPath, 'utf8'), customized)

  loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: { QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max' },
    generateSecret: false,
  })
  assert.equal(readFileSync(modelPath, 'utf8'), customized)
})

test('desktop client setup does not require packaged backend templates', () => {
  const base = mkdtempSync(resolve(tmpdir(), 'qwaudio-desktop-config-'))
  const root = resolve(base, 'app')
  const homeDirectory = resolve(base, 'home')
  mkdirSync(root, { recursive: true })
  mkdirSync(homeDirectory, { recursive: true })
  const env = {}

  const result = loadRuntimeEnvironment({
    root,
    homeDirectory,
    env,
    generateSecret: false,
    prepareBackendRuntime: false,
  })

  assert.equal(existsSync(result.configPath), true)
  assert.equal(existsSync(result.userModelPath), true)
  assert.equal(existsSync(result.openCodeWorkspace), false)
  assert.equal(existsSync(result.openClawWorkspace), false)
  assert.equal(existsSync(result.qoderWorkspace), false)
  assert.equal(existsSync(result.kimiWorkspace), false)
  assert.equal(existsSync(result.hermesWorkspace), false)
  assert.equal(existsSync(result.codeBuddyWorkspace), false)
  assert.equal(existsSync(result.codexWorkspace), false)
  assert.equal(existsSync(result.claudeWorkspace), false)
  assert.equal(existsSync(result.piWorkspace), false)
  assert.equal(existsSync(result.acpWorkspace), false)
  assert.equal(env.OPENCODE_WORKSPACE, undefined)
  assert.equal(env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE, undefined)
  assert.equal(env.OPENCLAW_STATE_DIR, undefined)
  assert.equal(env.QODER_WORKSPACE, undefined)
  assert.equal(env.KIMI_WORKSPACE, undefined)
  assert.equal(env.HERMES_WORKSPACE, undefined)
  assert.equal(env.CODEBUDDY_WORKSPACE, undefined)
  assert.equal(env.CODEX_WORKSPACE, undefined)
  assert.equal(env.CLAUDE_WORKSPACE, undefined)
  assert.equal(env.PI_WORKSPACE, undefined)
  assert.equal(env.ACP_WORKSPACE, undefined)
})

test('migrates private runtime data into the user config directory', () => {
  const target = fixture()
  const legacyDirectory = resolve(target.root, 'runtime')
  mkdirSync(legacyDirectory, { recursive: true })
  const legacyMemory = resolve(legacyDirectory, 'frontend-memory.json')
  const legacyTasks = resolve(legacyDirectory, 'tasks.json')
  writeFileSync(legacyMemory, JSON.stringify({
    version: 1,
    users: {
      user_personal: {
        old_memory: { value: '用户喜欢篮球', scope: 'memory' },
        old_user: { value: '称呼用户为船长', scope: 'user' },
      },
    },
  }))
  writeFileSync(legacyTasks, '{\"tasks\":true}')

  const result = loadRuntimeEnvironment({
    root: target.root,
    homeDirectory: target.homeDirectory,
    env: {},
    generateSecret: false,
  })

  assert.equal(
    result.frontendMemoryPath,
    resolve(result.configDirectory, 'MEMORY.md'),
  )
  assert.equal(
    result.taskStatePath,
    resolve(result.configDirectory, 'tasks.json'),
  )
  assert.match(readFileSync(result.frontendMemoryPath, 'utf8'), /用户喜欢篮球/)
  assert.match(readFileSync(result.userModelPath, 'utf8'), /称呼用户为船长/)
  assert.equal(readFileSync(result.taskStatePath, 'utf8'), '{\"tasks\":true}')
  assertPrivateMode(result.frontendMemoryPath)
  assertPrivateMode(result.taskStatePath)
  assert.equal(existsSync(legacyMemory), false)
  assert.equal(existsSync(legacyTasks), false)
  assert.deepEqual(new Set(result.migratedFiles), new Set([
    result.frontendMemoryPath,
    result.userModelPath,
    result.taskStatePath,
  ]))
})

test('requires only a DashScope credential from the user', () => {
  assert.doesNotThrow(() => requireDashScopeCredential({
    DASHSCOPE_API_KEY: 'key',
  }))
  assert.throws(() => requireDashScopeCredential({}), /DASHSCOPE_API_KEY/)
})

test('does not require a DashScope credential for speech-to-speech', () => {
  assert.doesNotThrow(() => requireRealtimeFrontendConfiguration({
    QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
  }))
  assert.doesNotThrow(() => requireRealtimeFrontendConfiguration({
    QWEN_AUDIO_REALTIME_PROVIDER: 's2s',
  }))
  assert.throws(
    () => requireRealtimeFrontendConfiguration({}),
    /DASHSCOPE_API_KEY/,
  )
  assert.throws(
    () => requireRealtimeFrontendConfiguration({
      QWEN_AUDIO_REALTIME_PROVIDER: 'speech2speech',
    }),
    /不支持的 Realtime 前台/,
  )
})
