import assert from 'node:assert/strict'
import test from 'node:test'

import {
  backendAuthenticationSupport,
  backendConfigurationSupport,
  backendLifecycleSpec,
  resolveBackendLifecycle,
} from '../../shared/backend-lifecycle.mjs'

test('describes installation, configuration, and authentication in one catalog', () => {
  const spec = backendLifecycleSpec('codebuddy')
  assert.equal(spec.installation.steps[0].packageEnv, 'CODEBUDDY_PACKAGE')
  assert.equal(spec.configuration.mode, 'backend-owned')
  assert.equal(spec.authentication.command, 'codebuddy')
})

test('keeps automatic Bailian configuration separate from backend login', () => {
  assert.equal(
    backendConfigurationSupport('opencode').mode,
    'bailian-or-backend-owned',
  )
  assert.deepEqual(backendAuthenticationSupport('opencode', {
    env: {
      DASHSCOPE_API_KEY: 'key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
    },
    platform: 'darwin',
  }), { required: false, supported: false })
})

test('does not equate installation with authentication or runtime readiness', () => {
  const lifecycle = resolveBackendLifecycle({ ready: true }, {
    installation: { supported: true },
    configuration: { mode: 'backend-owned' },
    authentication: {
      status: 'unauthenticated',
      required: true,
      supported: true,
    },
  })
  assert.equal(lifecycle.state, 'authentication-required')
  assert.equal(lifecycle.installation.status, 'installed')
  assert.equal(lifecycle.readiness.status, 'not-connected')
})
