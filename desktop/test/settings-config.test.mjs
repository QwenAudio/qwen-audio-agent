import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  applySettingsEnvironment,
  normalizeSettings,
  parseSettings,
  realtimeSettingsConfigured,
  realtimeSettingsConfiguration,
  updateSettingsContent,
} from '../src/settings-config.mjs'

const REALTIME_DEFAULTS = {
  wakeShortcut: 'CommandOrControl+Shift+Space',
  wakeWordEnabled: false,
  realtimeProvider: 'dashscope',
  realtimeBaseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  realtimeModel: 'qwen-audio-3.0-realtime-plus',
  audioRealtimeVoice: '',
  omniRealtimeVoice: '',
  stepfunApiKey: '',
  stepfunRealtimeUrl: 'wss://api.stepfun.com/v1/realtime',
  stepfunRealtimeModel: 'stepaudio-3-realtime-preview',
  stepfunRealtimeVoice: '',
  speechToSpeechRealtimeUrl: '',
  speechToSpeechAuthToken: '',
  miniCpmORealtimeUrl: '',
  miniCpmOAuthToken: '',
  openaiApiKey: '',
  gptLiveRealtimeUrl: 'wss://api.openai.com/v1/realtime',
  gptLiveRealtimeModel: 'gpt-realtime-2.1',
  gptLiveRealtimeVoice: '',
  googleApiKey: '',
  googleLiveRealtimeUrl: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
  googleLiveRealtimeModel: 'gemini-3.8-live',
  googleLiveRealtimeVoice: '',
  doubaoApiKey: '',
  doubaoSeeduplexRealtimeUrl: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',
  doubaoSeeduplexRealtimeModel: '1.2.6.1',
  doubaoSeeduplexRealtimeVoice: 'zh_female_vv_jupiter_bigtts',
}

const BACKEND_CONNECTION_DEFAULTS = {
  backendOwnership: 'owned',
  backendUrl: '',
  backendCredential: '',
}

const DESKTOP_LANGUAGE_DEFAULT = { language: 'auto' }

test('round-trips StepFun settings and detects only active provider changes', () => {
  const content = updateSettingsContent('STEPFUN_API_KEY=keep\n', {
    realtimeProvider: 'stepfun', stepfunApiKey: 'step-test',
    stepfunRealtimeVoice: 'custom-voice',
  })
  const settings = parseSettings(content)
  assert.equal(settings.stepfunApiKey, 'step-test')
  assert.equal(settings.dashscopeApiKey, '')
  assert.equal(settings.stepfunRealtimeVoice, 'custom-voice')
  assert.equal(realtimeSettingsConfigured(settings), true)
  assert.equal(realtimeSettingsConfigured({ ...settings, stepfunApiKey: '' }), false)
  assert.equal(realtimeSettingsConfigured({ ...settings, stepfunRealtimeUrl: 'https://example.com' }), false)
  const signature = value => realtimeSettingsConfiguration(value).active.signature
  assert.notEqual(signature(settings), signature({ ...settings, stepfunRealtimeVoice: 'new-voice' }))
  assert.notEqual(signature(settings), signature({ ...settings, stepfunApiKey: 'new-key' }))
  assert.equal(signature(settings), signature({ ...settings, audioRealtimeVoice: 'qwen-only' }))
  const env = applySettingsEnvironment(settings, {})
  assert.equal(env.STEPFUN_API_KEY, 'step-test')
  assert.equal(env.STEPFUN_REALTIME_MODEL, 'stepaudio-3-realtime-preview')
  applySettingsEnvironment({ stepfunApiKey: '' }, env)
  assert.equal(env.STEPFUN_API_KEY, '')
})

test('reads desktop-owned settings with friendly defaults', () => {
  assert.deepEqual(parseSettings(''), {
    gatewayUrl: 'http://127.0.0.1:3101',
    orbStyle: 'fluid',
    orbSkin: 'fluid',
    autoHideSeconds: 60,
    dashscopeApiKey: '',
    ...REALTIME_DEFAULTS,
    agentProtocol: 'none',
    backendModel: '',
    ...BACKEND_CONNECTION_DEFAULTS,
    nodePath: '',
    ...DESKTOP_LANGUAGE_DEFAULT,
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
    orbSkin: 'goo',
    autoHideSeconds: 60,
    dashscopeApiKey: 'sk-from-env',
    ...REALTIME_DEFAULTS,
    agentProtocol: 'none',
    backendModel: '',
    ...BACKEND_CONNECTION_DEFAULTS,
    nodePath: '',
    ...DESKTOP_LANGUAGE_DEFAULT,
  })
})

test('keeps profile defaults out of persisted desktop voice overrides', () => {
  const settings = parseSettings(
    'QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-plus-realtime\n',
  )

  assert.equal(settings.realtimeModel, 'qwen3.5-omni-plus-realtime')
  assert.equal(settings.audioRealtimeVoice, '')
  assert.equal(settings.omniRealtimeVoice, '')
  assert.equal(
    normalizeSettings({
      realtimeModel: 'qwen3.5-omni-flash-realtime',
    }).omniRealtimeVoice,
    '',
  )
})

test('persists both model family voices and clears only the selected family', () => {
  const settings = {
    realtimeModel: 'qwen3.5-omni-plus-realtime',
    audioRealtimeVoice: 'custom-audio', omniRealtimeVoice: 'custom-omni',
  }
  const content = updateSettingsContent('', settings)
  assert.equal(parseSettings(content).omniRealtimeVoice, 'custom-omni')
  assert.equal(parseSettings(content).audioRealtimeVoice, 'custom-audio')
  assert.match(content, /QWEN_OMNI_REALTIME_VOICE=custom-omni/)
  const cleared = updateSettingsContent(content, { omniRealtimeVoice: '' })
  assert.equal(parseSettings(cleared, { QWEN_OMNI_REALTIME_VOICE: 'stale' }).omniRealtimeVoice, '')
  assert.equal(parseSettings(cleared).audioRealtimeVoice, 'custom-audio')
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
    orbSkin: 'goo',
    autoHideSeconds: 120,
    dashscopeApiKey: 'secret',
    ...REALTIME_DEFAULTS,
    agentProtocol: 'qoder',
    realtimeModel: 'realtime-model',
    backendModel: '',
    ...BACKEND_CONNECTION_DEFAULTS,
    nodePath: '',
    ...DESKTOP_LANGUAGE_DEFAULT,
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
    orbSkin: 'fluid',
    autoHideSeconds: 60,
    dashscopeApiKey: '',
    ...REALTIME_DEFAULTS,
    agentProtocol: 'none',
    backendModel: '',
    ...BACKEND_CONNECTION_DEFAULTS,
    nodePath: '',
    ...DESKTOP_LANGUAGE_DEFAULT,
  })
})

test('reads, normalizes, and persists the desktop language', () => {
  assert.equal(parseSettings('QWEN_AUDIO_DESKTOP_LANGUAGE=en\n').language, 'en')
  assert.equal(parseSettings('QWEN_AUDIO_DESKTOP_LANGUAGE=zh-TW\n').language, 'zh-CN')
  assert.equal(parseSettings('QWEN_AUDIO_DESKTOP_LANGUAGE=invalid\n').language, 'auto')
  assert.match(
    updateSettingsContent('', { language: 'en' }),
    /QWEN_AUDIO_DESKTOP_LANGUAGE=en/,
  )
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

test('reads, updates, and falls back the orb skin selection', () => {
  // 新配置：QWEN_AUDIO_ORB_SKIN 直接生效，写回不碰旧 orbStyle 行。
  const content = updateSettingsContent(
    'QWEN_AUDIO_ORB_STYLE=goo\n',
    { orbSkin: 'firefly--lingxiaotian' },
  )
  assert.match(content, /QWEN_AUDIO_ORB_SKIN=firefly--lingxiaotian/)
  assert.match(content, /QWEN_AUDIO_ORB_STYLE=goo/)
  assert.equal(parseSettings(content).orbSkin, 'firefly--lingxiaotian')

  // 旧配置只有 orbStyle 时收敛为 orbSkin。
  assert.equal(parseSettings('QWEN_AUDIO_ORB_STYLE=goo\n').orbSkin, 'goo')

  // 非法 id 回退 fluid；空值回退 orbStyle。
  assert.equal(
    parseSettings('QWEN_AUDIO_ORB_SKIN=../escape\n').orbSkin,
    'fluid',
  )
  assert.equal(parseSettings([
    'QWEN_AUDIO_ORB_SKIN=',
    'QWEN_AUDIO_ORB_STYLE=goo',
    '',
  ].join('\n')).orbSkin, 'goo')
  assert.match(
    updateSettingsContent('', { orbSkin: 'bad id!' }),
    /QWEN_AUDIO_ORB_SKIN=fluid\n$/,
  )
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

test('writes provider-owned endpoint, model and both voices and clears a backend model', () => {
  const content = updateSettingsContent('QWEN_AUDIO_AGENT_BACKEND_MODEL=old\n', {
    realtimeBaseUrl: 'wss://voice.example.test/v1/realtime',
    realtimeModel: 'qwen-audio-3.0-realtime-plus',
    audioRealtimeVoice: 'custom-voice', omniRealtimeVoice: 'custom-omni',
    backendModel: '',
  })
  const settings = parseSettings(content)
  assert.equal(settings.realtimeBaseUrl, 'wss://voice.example.test/v1/realtime')
  assert.equal(settings.realtimeModel, 'qwen-audio-3.0-realtime-plus')
  assert.equal(settings.audioRealtimeVoice, 'custom-voice')
  assert.equal(settings.omniRealtimeVoice, 'custom-omni')
  assert.equal(settings.backendModel, '')
  assert.match(content, /QWEN_AUDIO_REALTIME_BASE_URL=/)
  assert.match(content, /^QWEN_AUDIO_AGENT_BACKEND_MODEL=$/m)
})

test('imports legacy provider settings without sharing their endpoints or credentials', () => {
  const content = 'QWEN_AUDIO_REALTIME_URL=wss://legacy.example/realtime\nDASHSCOPE_API_KEY=legacy-dash\nSTEPFUN_API_KEY=legacy-step\n'
  const settings = parseSettings(content)
  assert.equal(settings.realtimeBaseUrl, 'wss://legacy.example/realtime')
  assert.equal(settings.dashscopeApiKey, 'legacy-dash')
  assert.equal(settings.stepfunApiKey, 'legacy-step')
  const switched = parseSettings('QWEN_AUDIO_REALTIME_PROVIDER=stepfun\n' + content)
  assert.equal(switched.stepfunRealtimeUrl, 'wss://api.stepfun.com/v1/realtime')
  assert.equal(switched.stepfunApiKey, 'legacy-step')
})

test('reads and updates the Doubao Seeduplex desktop configuration', () => {
  const settings = parseSettings([
    'QWEN_AUDIO_REALTIME_PROVIDER=doubao',
    'DOUBAO_API_KEY=doubao-key',
    'DOUBAO_SEEDUPLEX_REALTIME_URL=wss://doubao.example/realtime',
    'DOUBAO_SEEDUPLEX_REALTIME_MODEL=1.2.6.1',
    'DOUBAO_SEEDUPLEX_REALTIME_VOICE=doubao-voice',
    '',
  ].join('\n'))

  assert.equal(settings.realtimeProvider, 'doubao-seeduplex')
  assert.equal(settings.doubaoApiKey, 'doubao-key')
  assert.equal(settings.doubaoSeeduplexRealtimeUrl, 'wss://doubao.example/realtime')
  assert.equal(settings.doubaoSeeduplexRealtimeModel, '1.2.6.1')
  assert.equal(settings.doubaoSeeduplexRealtimeVoice, 'doubao-voice')
  assert.equal(realtimeSettingsConfigured(settings), true)

  const content = updateSettingsContent('', settings)
  assert.match(content, /QWEN_AUDIO_REALTIME_PROVIDER=doubao-seeduplex/)
  assert.match(content, /DOUBAO_API_KEY=doubao-key/)
  assert.match(content, /DOUBAO_SEEDUPLEX_REALTIME_URL=wss:\/\/doubao\.example\/realtime/)
  assert.match(content, /DOUBAO_SEEDUPLEX_REALTIME_VOICE=doubao-voice/)
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

test('reads the unified endpoint and token only into the selected provider', () => {
  const settings = parseSettings('QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech\nSPEECH_TO_SPEECH_REALTIME_URL=ws://127.0.0.1:9000/realtime\nSPEECH_TO_SPEECH_AUTH_TOKEN=local-token\n')
  assert.equal(settings.speechToSpeechRealtimeUrl, 'ws://127.0.0.1:9000/realtime')
  assert.equal(settings.speechToSpeechAuthToken, 'local-token')
  assert.equal(settings.dashscopeApiKey, '')
  assert.equal(settings.stepfunApiKey, '')
})

test('reads and updates the MiniCPM-o desktop configuration', () => {
  const settings = parseSettings([
    'QWEN_AUDIO_REALTIME_PROVIDER=minicpmo',
    'MINICPM_O_REALTIME_URL=ws://127.0.0.1:9000/v1/realtime?mode=audio',
    'MINICPM_O_AUTH_TOKEN=private-token',
    '',
  ].join('\n'))

  assert.equal(settings.realtimeProvider, 'minicpm-o')
  assert.equal(
    settings.miniCpmORealtimeUrl,
    'ws://127.0.0.1:9000/v1/realtime?mode=audio',
  )
  assert.equal(settings.miniCpmOAuthToken, 'private-token')
  assert.equal(realtimeSettingsConfigured(settings), true)

  const content = updateSettingsContent('', settings)
  assert.match(content, /QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o/)
  assert.match(
    content,
    /MINICPM_O_REALTIME_URL="ws:\/\/127\.0\.0\.1:9000\/v1\/realtime\?mode=audio"/,
  )
  assert.match(content, /MINICPM_O_AUTH_TOKEN=private-token/)
})

test('uses the official MiniCPM-o loopback endpoint as an effective default', () => {
  const settings = parseSettings(
    'QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o\n',
  )

  assert.equal(
    settings.miniCpmORealtimeUrl,
    'ws://127.0.0.1:8006/v1/realtime?mode=audio',
  )
  assert.equal(realtimeSettingsConfigured(settings), true)
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
    realtimeProvider: 'dashscope',
    dashscopeApiKey: 'sk-valid',
    realtimeBaseUrl: 'https://voice.example.test/realtime',
  }), false)
  assert.equal(realtimeSettingsConfigured({
    realtimeProvider: 'speech-to-speech',
    speechToSpeechRealtimeUrl: 'not-a-websocket-url',
  }), false)
  assert.equal(realtimeSettingsConfigured({
    realtimeProvider: 'minicpm-o',
    miniCpmORealtimeUrl: 'http://127.0.0.1:8006/v1/realtime',
  }), false)
})

test('persists inactive service configuration without changing the selected provider', () => {
  const content = updateSettingsContent('', {
    realtimeProvider: 'dashscope', dashscopeApiKey: 'sk-valid',
    speechToSpeechRealtimeUrl: 'ws://127.0.0.1:8765/realtime',
    speechToSpeechAuthToken: 'inactive-secret',
  })
  const settings = parseSettings(content)
  assert.equal(settings.realtimeProvider, 'dashscope')
  assert.equal(settings.dashscopeApiKey, 'sk-valid')
  assert.equal(settings.speechToSpeechRealtimeUrl, 'ws://127.0.0.1:8765/realtime')
  assert.equal(settings.speechToSpeechAuthToken, 'inactive-secret')
  assert.match(content, /SPEECH_TO_SPEECH_AUTH_TOKEN=inactive-secret/)
})

test('rejects invalid Speech-to-Speech service URLs', () => {
  assert.throws(() => updateSettingsContent('', {
    realtimeProvider: 'speech-to-speech',
    speechToSpeechRealtimeUrl: 'https://voice.example.test/realtime',
  }), /只支持 WS 或 WSS/)
})

test('rejects invalid Qwen Audio service URLs', () => {
  assert.throws(() => updateSettingsContent('', {
    realtimeBaseUrl: 'https://voice.example.test/realtime',
  }), /服务地址只支持 WS 或 WSS/)
})

test('rejects invalid Gateway URLs', () => {
  assert.throws(() => updateSettingsContent('', {
    gatewayUrl: 'file:///tmp/gateway',
    orbStyle: 'fluid',
  }), /只支持 HTTP 或 HTTPS/)
})

test('desktop settings expose external backend connection controls', () => {
  const html = readFileSync(
    new URL('../src/settings.html', import.meta.url),
    'utf8',
  )
  assert.match(html, /id="current-realtime"/)
  assert.match(html, /id="current-backend"/)
  assert.match(html, /id="realtime-provider"/)
  assert.match(html, /id="realtime-settings-panel"/)
  assert.doesNotMatch(html, /data-provider-panel|provider-segment/)
  assert.match(html, />语音前台</)
  assert.match(html, />后台 Agent</)
  assert.match(html, /for="backend-model">后台模型</)
  assert.match(html, />应用</)
  assert.match(html, /role="tablist"/)
  assert.match(html, /data-settings-tab="voice"/)
  assert.match(html, /data-settings-tab="backend"/)
  assert.match(html, /data-settings-tab="app"/)
  assert.match(html, /role="tabpanel"/)
  assert.match(html, /id="backend-model"/)
  assert.match(html, /id="backend-ownership"/)
  assert.match(html, /id="backend-url"/)
  assert.match(html, /id="backend-credential"/)
  assert.match(html, /id="gateway-url"/)
  assert.doesNotMatch(html, /id="remote-access-status"/)
  assert.doesNotMatch(html, /id="enable-remote-access"/)
  assert.doesNotMatch(html, /id="invite-remote-client"/)
  assert.doesNotMatch(html, /id="disable-remote-access"/)
  assert.doesNotMatch(html, /id="gateway-pairing-dialog"/)
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
  // 后台 Agent 选项按本机可用性动态渲染到可搜索选择器。
  assert.match(html, /id="backend-picker-trigger"/)
  assert.match(html, /aria-haspopup="listbox"/)
  assert.match(html, /id="backend-search"/)
  assert.match(html, /<div\s+id="backend-list"/)
  assert.match(html, /role="listbox"/)
  assert.match(html, /id="refresh-backends"/)
  const settingsRenderer = readFileSync(
    new URL('../src/settings.js', import.meta.url),
    'utf8',
  )
  assert.match(settingsRenderer, /backendPickerName\.title = backendPickerName\.textContent/)
  assert.match(settingsRenderer, /name\.title = state\.label/)
  assert.match(settingsRenderer, /status\.title = status\.textContent/)
  // 版本与自动更新状态由主进程推送渲染
  assert.match(html, /id="updater-status"/)
  assert.match(html, /id="check-updates"/)
  assert.match(html, /<script src="\.\/settings\.js" type="module"><\/script>/)
  assert.doesNotMatch(html, /<option value="kimi">/)
  for (const id of [
    'api-key',
    'backend-permission-mode',
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`))
  }
})

test('reads and updates an external OpenClaw connection', () => {
  const settings = parseSettings([
    'AGENT_PROTOCOL=openclaw',
    'QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP=external',
    'OPENCLAW_BASE_URL=wss://openclaw.example.test',
    'OPENCLAW_GATEWAY_TOKEN=private-token',
    '',
  ].join('\n'))

  assert.equal(settings.backendOwnership, 'external')
  assert.equal(settings.backendUrl, 'wss://openclaw.example.test')
  assert.equal(settings.backendCredential, 'private-token')

  const content = updateSettingsContent('', {
    agentProtocol: 'openclaw',
    backendOwnership: 'external',
    backendUrl: 'https://openclaw.example.test/',
    backendCredential: 'new-token',
  })
  assert.match(content, /QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP=external/)
  assert.match(content, /OPENCLAW_BASE_URL=https:\/\/openclaw\.example\.test/)
  assert.match(content, /OPENCLAW_GATEWAY_TOKEN=new-token/)
})

test('rejects external mode for unsupported backends and missing addresses', () => {
  assert.throws(() => normalizeSettings({
    agentProtocol: 'opencode',
    backendOwnership: 'external',
    backendUrl: 'http://127.0.0.1:4096',
  }), /不支持连接外部后台服务/)
  assert.throws(() => normalizeSettings({
    agentProtocol: 'openclaw',
    backendOwnership: 'external',
    backendUrl: '',
  }), /请填写外部后台服务地址/)
  assert.throws(() => normalizeSettings({
    agentProtocol: 'openclaw',
    backendOwnership: 'external',
    backendUrl: 'wss://user:secret@openclaw.example.test',
  }), /不能包含用户名或密码/)
})

test('applies a saved settings patch to the live environment', () => {
  const env = {
    DASHSCOPE_API_KEY: 'stale-key',
    QWEN_AUDIO_REALTIME_MODEL: 'old-model',
    UNRELATED: 'kept',
  }
  // 只写回本次保存的字段：config.env 只填充未设置的槽位，不同步会让
  // 本进程继续沿用首次加载的旧值，刚保存的 Key 看起来像被忽略。
  applySettingsEnvironment({ dashscopeApiKey: 'fresh-key' }, env)
  assert.equal(env.DASHSCOPE_API_KEY, 'fresh-key')
  assert.equal(env.QWEN_AUDIO_REALTIME_MODEL, 'old-model')
  assert.equal(env.UNRELATED, 'kept')
})

test('a cleared setting releases its environment slot', () => {
  const env = { QWEN_AUDIO_AGENT_BACKEND_MODEL: 'pinned-model' }
  applySettingsEnvironment({ backendModel: '' }, env)
  assert.equal('QWEN_AUDIO_AGENT_BACKEND_MODEL' in env, false)
})

test('saved settings preserve literal backslashes, quotes and comment characters', () => {
  for (const nodePath of [
    String.raw`C:\Program Files\nodejs\node.exe`,
    String.raw`\\server\工具 (x64)\node.exe`,
    "C:\\Users\\O'Brien\\nodejs",
    'D:\\tools\\node "lts"',
    '/Users/a/`node` "lts"',
    '/tools/node #release',
  ]) {
    let content = ''
    for (let save = 0; save < 3; save += 1) {
      content = updateSettingsContent(content, { nodePath })
      assert.equal(parseSettings(content).nodePath, nodePath)
    }
  }
})

test('settings reject unrepresentable dotenv values rather than corrupting them', () => {
  for (const nodePath of ["/a'\"`b", 'a\nb', 'a\rb', 'a\0b']) {
    assert.throws(() => updateSettingsContent('', { nodePath }), /无法保存/)
  }
})
