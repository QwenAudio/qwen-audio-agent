import { resolve } from 'node:path'
import { baseEnvironment, clean } from './shared.mjs'

const CODEX_PROVIDER = 'qwen-audio-agent'

export const codexBackendDriver = {
  id: 'codex',
  label: 'Codex',

  createProfile({
    root,
    directory,
    cliPath,
    model,
    modelUrl,
    permissionMode,
  }) {
    return {
      label: this.label,
      command: process.execPath,
      args: [resolve(root, 'scripts/codex-acp.mjs')],
      cwd: directory,
      env: {
        ...baseEnvironment(),
        ELECTRON_RUN_AS_NODE: '1',
        ...(clean(cliPath) ? { CODEX_ACP_BIN: clean(cliPath) } : {}),
        ...(clean(modelUrl)
          ? {
              MODEL_PROVIDER: CODEX_PROVIDER,
              CODEX_CONFIG: JSON.stringify({
                ...(clean(model) ? { model: clean(model) } : {}),
                model_provider: CODEX_PROVIDER,
                model_providers: {
                  [CODEX_PROVIDER]: {
                    name: CODEX_PROVIDER,
                    base_url: clean(modelUrl),
                    env_key: 'DASHSCOPE_API_KEY',
                    wire_api: 'responses',
                  },
                },
              }),
            }
          : {}),
        ...(permissionMode === 'full'
          ? { INITIAL_AGENT_MODE: 'agent-full-access' }
          : {}),
      },
      externalMcp: true,
      nativeDelegation: false,
      backendUi: false,
    }
  },
}
