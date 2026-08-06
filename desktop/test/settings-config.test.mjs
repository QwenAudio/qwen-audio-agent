import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  parseSettings,
  realtimeSettingsConfigured,
  updateSettingsContent,
} from '../src/settings-config.mjs'

const REALTIME_DEFAULTS = {
  wakeShortcut: 'CommandOrControl+Shift+Space',
  wakeWordEnabled: false,
  realtimeProvider: 'dashscope',
  realtimeModel: 'qwen-audio-3.0-realtime-plus',
  speechToSpeechRealtimeUrl: '',
  speechToSpeechAuthToken: '',
}

test('reads desktop-owned settings with friendly defaults', () => {
  assert.deepEqual(parseSettings(''), {
    gatewayUrl: 'http://127.0.0.1:3101',
    orbStyle: 'fluid',
    autoHideSeconds: 60,
    dashscopeApiKey: '',
    ...REALTIME_DEFAULTS,
    agentProtocol: 'none',
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
    autoHideSeconds: 60,
    dashscopeApiKey: 'sk-from-env',
    ...REALTIME_DEFAULTS,
    agentProtocol: 'none',
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
    autoHideSeconds: 120,
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
    autoHideSeconds: 120,
    dashscopeApiKey: 'secret',
    ...REALTIME_DEFAULTS,
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
    autoHideSeconds: 120,
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
    autoHideSeconds: 60,
    dashscopeApiKey: '',
    ...REALTIME_DEFAULTS,
    agentProtocol: 'none',
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

test('reads, updates, and disables desktop auto hide', () => {
  const content = updateSettingsContent('', { autoHideSeconds: 300 })
  assert.match(content, /QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS=300/)
  assert.equal(parseSettings(content).autoHideSeconds, 300)
  assert.equal(parseSettings(
    'QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS=0\n',
  ).autoHideSeconds, 0)
  assert.equal(parseSettings(
    'QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS=5\n',
  ).autoHideSeconds, 60)
  assert.equal(parseSettings(
    'QWEN_AUDIO_DESKTOP_AUTO_SLEEP_SECONDS=300\n',
  ).autoHideSeconds, 300)
})

test('reads and updates a supported desktop wake shortcut', () => {
  const content = updateSettingsContent('', {
    wakeShortcut: 'CommandOrControl+Alt+Space',
  })
  assert.match(
    content,
    /QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT=CommandOrControl\+Alt\+Space/,
  )
  assert.equal(
    parseSettings(content).wakeShortcut,
    'CommandOrControl+Alt+Space',
  )
  assert.equal(
    parseSettings(
      'QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT=CommandOrControl+Alt+Shift+J\n',
    ).wakeShortcut,
    'CommandOrControl+Alt+Shift+J',
  )
  assert.equal(
    parseSettings('QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT=F13\n').wakeShortcut,
    'F13',
  )
  assert.equal(
    parseSettings('QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT=invalid\n').wakeShortcut,
    'CommandOrControl+Shift+Space',
  )
  assert.equal(
    parseSettings(
      'QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT=CommandOrControl+Space\n',
    ).wakeShortcut,
    'CommandOrControl+Shift+Space',
  )
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

test('reads and updates the Speech-to-Speech desktop configuration', () => {
  const settings = parseSettings([
    'QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech',
    'SPEECH_TO_SPEECH_REALTIME_URL=wss://voice.example.test/v1/realtime',
    'SPEECH_TO_SPEECH_AUTH_TOKEN=private-token',
    '',
  ].join('\n'))

  assert.equal(settings.realtimeProvider, 'speech-to-speech')
  assert.equal(
    settings.speechToSpeechRealtimeUrl,
    'wss://voice.example.test/v1/realtime',
  )
  assert.equal(settings.speechToSpeechAuthToken, 'private-token')
  assert.equal(realtimeSettingsConfigured(settings), true)

  const content = updateSettingsContent('', settings)
  assert.match(content, /QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech/)
  assert.match(
    content,
    /SPEECH_TO_SPEECH_REALTIME_URL=wss:\/\/voice\.example\.test\/v1\/realtime/,
  )
  assert.match(content, /SPEECH_TO_SPEECH_AUTH_TOKEN=private-token/)
})

test('uses the standard Speech-to-Speech URL as an effective default', () => {
  const settings = parseSettings(
    'QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech\n',
  )

  assert.equal(
    settings.speechToSpeechRealtimeUrl,
    'ws://127.0.0.1:8765/v1/realtime',
  )
  assert.equal(realtimeSettingsConfigured(settings), true)
  assert.equal(realtimeSettingsConfigured({
    realtimeProvider: 'speech-to-speech',
    speechToSpeechRealtimeUrl: '',
  }), true)
})

test('supports the compact S2S aliases when reading existing configuration', () => {
  const settings = parseSettings([
    'QWEN_AUDIO_REALTIME_PROVIDER=s2s',
    'S2S_REALTIME_URL=ws://127.0.0.1:9000/realtime',
    'S2S_API_KEY=alias-token',
    '',
  ].join('\n'))

  assert.equal(settings.realtimeProvider, 'speech-to-speech')
  assert.equal(
    settings.speechToSpeechRealtimeUrl,
    'ws://127.0.0.1:9000/realtime',
  )
  assert.equal(settings.speechToSpeechAuthToken, 'alias-token')
})

test('requires the selected realtime provider configuration', () => {
  assert.equal(realtimeSettingsConfigured({
    realtimeProvider: 'dashscope',
    dashscopeApiKey: '',
  }), false)
  assert.equal(realtimeSettingsConfigured({
    realtimeProvider: 'dashscope',
    dashscopeApiKey: 'sk-valid',
  }), true)
  assert.equal(realtimeSettingsConfigured({
    realtimeProvider: 'speech-to-speech',
    speechToSpeechRealtimeUrl: 'not-a-websocket-url',
  }), false)
})

test('does not configure Speech-to-Speech while DashScope is selected', () => {
  const content = updateSettingsContent('', {
    realtimeProvider: 'dashscope',
    dashscopeApiKey: 'sk-valid',
    speechToSpeechRealtimeUrl: '',
  })

  assert.match(content, /QWEN_AUDIO_REALTIME_PROVIDER=dashscope/)
  assert.match(content, /SPEECH_TO_SPEECH_REALTIME_URL=\n?/)
  assert.doesNotMatch(
    content,
    /SPEECH_TO_SPEECH_REALTIME_URL=ws:\/\/127\.0\.0\.1:8765/,
  )
})

test('rejects invalid Speech-to-Speech service URLs', () => {
  assert.throws(() => updateSettingsContent('', {
    realtimeProvider: 'speech-to-speech',
    speechToSpeechRealtimeUrl: 'https://voice.example.test/realtime',
  }), /只支持 WS 或 WSS/)
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
  assert.match(html, /id="realtime-provider"/)
  assert.match(html, /value="speech-to-speech"/)
  assert.match(html, /id="speech-to-speech-url"/)
  assert.match(html, /id="speech-to-speech-token"/)
  assert.match(html, />语音前台</)
  assert.match(html, />后台 Agent</)
  assert.match(html, />应用</)
  assert.match(html, /role="tablist"/)
  assert.match(html, /data-settings-tab="voice"/)
  assert.match(html, /data-settings-tab="backend"/)
  assert.match(html, /data-settings-tab="app"/)
  assert.match(html, /role="tabpanel"/)
  assert.match(html, /Qwen-Audio-Realtime/)
  assert.match(html, /DashScope/)
  assert.match(html, /Speech-to-Speech/)
  assert.match(html, /Hugging Face/)
  assert.match(html, /id="get-api-key"/)
  assert.match(html, /id="realtime-model"/)
  assert.match(html, /id="backend-model"/)
  assert.match(html, /id="auto-hide-seconds"/)
  assert.match(html, /id="wake-shortcut"/)
  assert.match(html, /id="record-wake-shortcut"/)
  assert.match(html, /id="reset-wake-shortcut"/)
  assert.match(html, /id="wake-word-enabled"/)
  assert.match(html, />自动休眠</)
  assert.match(html, />显示快捷键</)
  assert.match(html, />语音唤醒</)
  assert.doesNotMatch(html, />空闲休眠</)
  assert.doesNotMatch(html, />自动隐藏</)
  assert.doesNotMatch(html, />全局快捷键</)
  // 后台 Agent 列表按本机可用性检测结果动态渲染，HTML 里只保留空容器
  assert.match(html, /<div\s+id="backend-list"/)
  assert.match(html, /role="radiogroup"/)
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
