import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  applySettingsEnvironment,
  normalizeSettings,
  parseSettings,
  realtimeSettingsConfigured,
  updateSettingsContent,
} from '../src/settings-config.mjs'

const REALTIME_DEFAULTS = {
  wakeShortcut: 'CommandOrControl+Shift+Space',
  nativeInputEnabled: false,
  nativeInputShortcut: 'CommandOrControl+Shift+D',
  wakeWordEnabled: false,
  realtimeProvider: 'dashscope',
  realtimeBaseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  realtimeModel: 'qwen-audio-3.0-realtime-plus',
  audioRealtimeVoice: '',
  omniRealtimeVoice: '',
  speechToSpeechRealtimeUrl: '',
  speechToSpeechAuthToken: '',
}

const BACKEND_CONNECTION_DEFAULTS = {
  backendOwnership: 'owned',
  backendUrl: '',
  backendCredential: '',
}

const DESKTOP_LANGUAGE_DEFAULT = { language: 'auto' }

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

test('persists independent desktop voice overrides without changing them on model switch', () => {
  const audio = [
    'QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-flash',
    'QWEN_AUDIO_REALTIME_VOICE=custom-audio',
    'QWEN_OMNI_REALTIME_VOICE=custom-omni',
    '',
  ].join('\n')
  const omni = updateSettingsContent(audio, {
    realtimeModel: 'qwen3.5-omni-plus-realtime',
  })
  assert.match(omni, /QWEN_AUDIO_REALTIME_VOICE=custom-audio/)
  assert.match(omni, /QWEN_OMNI_REALTIME_VOICE=custom-omni/)

  const updated = updateSettingsContent(omni, {
    audioRealtimeVoice: 'next-audio',
    omniRealtimeVoice: '',
  })
  assert.match(updated, /QWEN_AUDIO_REALTIME_VOICE=next-audio/)
  assert.doesNotMatch(updated, /QWEN_OMNI_REALTIME_VOICE=/)
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

test('updates the Qwen Audio endpoint, family voices and clears a backend model', () => {
  const content = updateSettingsContent([
    'QWEN_AUDIO_REALTIME_BASE_URL=wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    'QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus',
    'QWEN_AUDIO_REALTIME_VOICE=longanqian',
    'QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max',
    '',
  ].join('\n'), {
    realtimeBaseUrl: 'wss://voice.example.test/v1/realtime',
    realtimeModel: 'compatible-audio-model',
    audioRealtimeVoice: 'custom-voice',
    omniRealtimeVoice: 'custom-omni',
    backendModel: '',
  })

  assert.match(
    content,
    /QWEN_AUDIO_REALTIME_BASE_URL=wss:\/\/voice\.example\.test\/v1\/realtime/,
  )
  assert.match(content, /QWEN_AUDIO_REALTIME_MODEL=compatible-audio-model/)
  assert.match(content, /QWEN_AUDIO_REALTIME_VOICE=custom-voice/)
  assert.match(content, /QWEN_OMNI_REALTIME_VOICE=custom-omni/)
  assert.match(content, /QWEN_AUDIO_AGENT_BACKEND_MODEL=\n?/)

  const settings = parseSettings(content)
  assert.equal(settings.realtimeBaseUrl, 'wss://voice.example.test/v1/realtime')
  assert.equal(settings.realtimeModel, 'compatible-audio-model')
  assert.equal(settings.audioRealtimeVoice, 'custom-voice')
  assert.equal(settings.omniRealtimeVoice, 'custom-omni')
})

test('supports the legacy Qwen Audio realtime URL alias', () => {
  const settings = parseSettings(
    'QWEN_AUDIO_REALTIME_URL=wss://legacy.example.test/realtime\n',
  )

  assert.equal(
    settings.realtimeBaseUrl,
    'wss://legacy.example.test/realtime',
  )
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
    realtimeProvider: 'dashscope',
    dashscopeApiKey: 'sk-valid',
    realtimeBaseUrl: 'https://voice.example.test/realtime',
  }), false)
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

test('rejects invalid Qwen Audio service URLs', () => {
  assert.throws(() => updateSettingsContent('', {
    realtimeBaseUrl: 'https://voice.example.test/realtime',
  }), /Qwen Audio 服务地址只支持 WS 或 WSS/)
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
  assert.match(html, /id="dashscope-api-key"/)
  assert.match(html, /id="realtime-provider"/)
  assert.match(html, /value="speech-to-speech"/)
  assert.match(html, /id="speech-to-speech-url"/)
  assert.match(html, /id="speech-to-speech-token"/)
  assert.match(html, />语音前台</)
  assert.match(html, />后台 Agent</)
  assert.match(html, /for="backend-model">Model</)
  assert.match(html, />应用</)
  assert.match(html, /role="tablist"/)
  assert.match(html, /data-settings-tab="voice"/)
  assert.match(html, /data-settings-tab="backend"/)
  assert.match(html, /data-settings-tab="app"/)
  assert.match(html, /role="tabpanel"/)
  assert.match(html, /Qwen Realtime/)
  assert.match(html, /DashScope 兼容协议/)
  assert.match(html, /DashScope/)
  assert.match(html, /Speech-to-Speech/)
  assert.match(html, /Hugging Face/)
  assert.match(html, /id="get-api-key"/)
  assert.match(html, /id="realtime-base-url"/)
  assert.match(html, /id="realtime-model"/)
  assert.doesNotMatch(html, /id="realtime-model-options"/)
  assert.match(html, />DashScope</)
  assert.doesNotMatch(html, /value="qwen-audio-3\.0-realtime-flash"/)
  assert.match(html, /id="realtime-voice"/)
  assert.doesNotMatch(html, /id="realtime-voice-options"/)
  assert.doesNotMatch(html, /id="realtime-voice"[\s\S]{0,160}\blist=/)
  assert.match(
    html,
    /data-provider-panel="dashscope"[\s\S]*id="realtime-voice"[\s\S]*data-provider-panel="speech-to-speech"/,
  )
  assert.match(html, /id="backend-model"/)
  assert.match(html, /id="backend-ownership"/)
  assert.match(html, /id="backend-url"/)
  assert.match(html, /id="backend-credential"/)
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
