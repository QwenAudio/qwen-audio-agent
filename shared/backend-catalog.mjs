const definitions = new Map([
  ['opencode', {
    id: 'opencode',
    label: 'OpenCode',
    baseUrlEnvironment: 'OPENCODE_BASE_URL',
    defaultBaseUrl: 'http://127.0.0.1:4096',
    supportsFullPermission: true,
  }],
  ['openclaw', {
    id: 'openclaw',
    label: 'OpenClaw',
    baseUrlEnvironment: 'OPENCLAW_BASE_URL',
    defaultBaseUrl: 'http://127.0.0.1:18789',
    supportsFullPermission: false,
  }],
  ['qoder', {
    id: 'qoder',
    label: 'Qoder',
    supportsFullPermission: true,
  }],
  ['kimi', {
    id: 'kimi',
    label: 'Kimi Code',
    supportsFullPermission: true,
  }],
  ['hermes', {
    id: 'hermes',
    label: 'Hermes',
    supportsFullPermission: true,
  }],
  ['codebuddy', {
    id: 'codebuddy',
    label: 'CodeBuddy',
    supportsFullPermission: true,
  }],
  ['codex', {
    id: 'codex',
    label: 'Codex',
    supportsFullPermission: true,
  }],
  ['claude', {
    id: 'claude',
    label: 'Claude Code',
    supportsFullPermission: true,
  }],
  ['acp', {
    id: 'acp',
    label: 'ACP Agent',
    supportsFullPermission: false,
  }],
])

export function backendDefinition(protocol) {
  return definitions.get(normalizeBackendProtocol(protocol)) || null
}

export function backendNames() {
  return [...definitions.keys()]
}

export function normalizeBackendProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase()
  return protocol === 'none' ? '' : protocol
}
