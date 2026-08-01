import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  parseSettings,
  updateSettingsContent,
} from '../src/settings-config.mjs'

test('reads desktop-owned settings with friendly defaults', () => {
  assert.deepEqual(parseSettings(''), {
    gatewayUrl: 'http://127.0.0.1:3101',
    orbStyle: 'fluid',
    dashscopeApiKey: '',
    agentProtocol: 'none',
    realtimeModel: 'qwen-audio-3.0-realtime-plus',
    backendModel: '',
  })
})

test('shows effective client settings when user config is empty', () => {
  assert.deepEqual(parseSettings('', {
    QWEN_AUDIO_AGENT_URL: 'http://127.0.0.1:3200',
    QWEN_AUDIO_ORB_STYLE: 'goo',
    DASHSCOPE_API_KEY: 'sk-from-env',
  }), {
    gatewayUrl: 'http://127.0.0.1:3200',
    orbStyle: 'goo',
    dashscopeApiKey: 'sk-from-env',
    agentProtocol: 'none',
    realtimeModel: 'qwen-audio-3.0-realtime-plus',
    backendModel: '',
  })
})

test('updates client settings without changing Gateway-owned configuration', () => {
  const content = updateSettingsContent([
    '# local settings',
    'CUSTOM_SETTING=keep',
    'DASHSCOPE_API_KEY=secret',
    'QWEN_AUDIO_REALTIME_MODEL=realtime-model',
    'AGENT_PROTOCOL=qoder',
    'QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=full',
    '',
  ].join('\n'), {
    gatewayUrl: 'http://127.0.0.1:3200',
    orbStyle: 'goo',
  })

  assert.match(content, /CUSTOM_SETTING=keep/)
  assert.match(content, /DASHSCOPE_API_KEY=secret/)
  assert.match(content, /QWEN_AUDIO_REALTIME_MODEL=realtime-model/)
  assert.match(content, /AGENT_PROTOCOL=qoder/)
  assert.match(content, /QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=full/)
  assert.match(content, /QWEN_AUDIO_AGENT_URL=http:\/\/127\.0\.0\.1:3200/)
  assert.match(content, /QWEN_AUDIO_ORB_STYLE=goo/)
  assert.deepEqual(parseSettings(content), {
    gatewayUrl: 'http://127.0.0.1:3200',
    orbStyle: 'goo',
    dashscopeApiKey: 'secret',
    agentProtocol: 'qoder',
    realtimeModel: 'realtime-model',
    backendModel: '',
  })
})

test('updates the DashScope key without touching other settings', () => {
  const content = updateSettingsContent([
    'DASHSCOPE_API_KEY=old-secret',
    'QWEN_AUDIO_AGENT_URL=http://127.0.0.1:3200',
    '',
  ].join('\n'), {
    dashscopeApiKey: 'sk-new',
  })

  assert.match(content, /DASHSCOPE_API_KEY=sk-new/)
  assert.match(content, /QWEN_AUDIO_AGENT_URL=http:\/\/127\.0\.0\.1:3200/)
  assert.doesNotMatch(content, /old-secret/)
})

test('keeps the stored DashScope key when the field is not part of the update', () => {
  const content = updateSettingsContent('DASHSCOPE_API_KEY=secret\n', {
    gatewayUrl: 'http://127.0.0.1:3101',
    orbStyle: 'fluid',
  })

  assert.match(content, /DASHSCOPE_API_KEY=secret/)
})

test('clears the DashScope key when the field is emptied', () => {
  const content = updateSettingsContent('DASHSCOPE_API_KEY=secret\n', {
    dashscopeApiKey: '',
  })

  assert.match(content, /DASHSCOPE_API_KEY=\n?/)
  assert.doesNotMatch(content, /secret/)
})

test('an explicitly empty key and backend override stale process values', () => {
  assert.deepEqual(parseSettings([
    'DASHSCOPE_API_KEY=',
    'AGENT_PROTOCOL=none',
    '',
  ].join('\n'), {
    DASHSCOPE_API_KEY: 'stale-key',
    AGENT_PROTOCOL: 'openclaw',
  }), {
    gatewayUrl: 'http://127.0.0.1:3101',
    orbStyle: 'fluid',
    dashscopeApiKey: '',
    agentProtocol: 'none',
    realtimeModel: 'qwen-audio-3.0-realtime-plus',
    backendModel: '',
  })
})

test('updates the selected backend while preserving unrelated configuration', () => {
  const content = updateSettingsContent([
    'AGENT_PROTOCOL=openclaw',
    'CUSTOM_SETTING=keep',
    '',
  ].join('\n'), {
    agentProtocol: 'opencode',
  })

  assert.match(content, /AGENT_PROTOCOL=opencode/)
  assert.match(content, /CUSTOM_SETTING=keep/)
})

test('updates the realtime model and clears an explicit backend model', () => {
  const content = updateSettingsContent([
    'QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus',
    'QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max',
    '',
  ].join('\n'), {
    realtimeModel: 'qwen-audio-3.0-realtime-flash',
    backendModel: '',
  })

  assert.match(
    content,
    /QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3\.0-realtime-flash/,
  )
  assert.match(content, /QWEN_AUDIO_AGENT_BACKEND_MODEL=\n?/)
})

test('rejects invalid Gateway URLs', () => {
  assert.throws(() => updateSettingsContent('', {
    gatewayUrl: 'file:///tmp/gateway',
    orbStyle: 'fluid',
  }), /只支持 HTTP 或 HTTPS/)
})

test('desktop settings expose the embedded voice service without editing backend ownership', () => {
  const html = readFileSync(
    new URL('../src/settings.html', import.meta.url),
    'utf8',
  )
  assert.match(html, /id="current-realtime"/)
  assert.match(html, /id="current-backend"/)
  assert.match(html, /id="dashscope-api-key"/)
  assert.match(html, /id="get-api-key"/)
  assert.match(html, /id="agent-protocol"/)
  assert.match(html, /id="realtime-model"/)
  assert.match(html, /id="backend-model"/)
  // 后台 Agent 选项按本机可用性检测结果动态渲染，HTML 里只保留空容器
  assert.match(html, /<select id="agent-protocol"><\/select>/)
  assert.match(html, /id="refresh-backends"/)
  // 版本与自动更新状态由主进程推送渲染
  assert.match(html, /id="updater-status"/)
  assert.match(html, /id="check-updates"/)
  assert.match(html, /<script src="\.\/settings\.js" type="module"><\/script>/)
  assert.doesNotMatch(html, /<option value="kimi">/)
  for (const id of [
    'api-key',
    'realtime-voice',
    'backend-permission-mode',
    'backend-url',
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`))
  }
})
