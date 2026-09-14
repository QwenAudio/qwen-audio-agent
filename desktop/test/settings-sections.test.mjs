import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeSettingsSection,
  preserveSettingsDrafts,
  settingsSectionChanged,
  settingsSectionPatch,
} from '../src/settings-sections.mjs'
import { parseSettings } from '../src/settings-config.mjs'

const applied = {
  gatewayUrl: 'http://127.0.0.1:3101',
  orbSkin: 'fluid',
  autoHideSeconds: 60,
  wakeShortcut: 'CommandOrControl+Shift+Space',
  wakeWordEnabled: false,
  language: 'zh-CN',
  dashscopeApiKey: 'key',
  realtimeBaseUrl: 'wss://dashscope.example/realtime',
  realtimeProvider: 'dashscope',
  realtimeModel: 'qwen-audio',
  audioRealtimeVoice: 'Cherry',
  omniRealtimeVoice: 'Ethan',
  speechToSpeechRealtimeUrl: '',
  speechToSpeechAuthToken: '',
  miniCpmORealtimeUrl: 'ws://127.0.0.1:8006/v1/realtime?mode=audio',
  miniCpmOAuthToken: '',
  agentProtocol: 'codex',
  backendModel: '',
  backendOwnership: 'owned',
  backendUrl: '',
  backendCredential: '',
  nodePath: '',
}

test('merges only the settings section selected for Apply', () => {
  const draft = {
    ...applied,
    realtimeProvider: 'minicpm-o',
    agentProtocol: 'qwen',
    language: 'en',
  }

  const next = mergeSettingsSection(applied, draft, 'backend')

  assert.equal(next.agentProtocol, 'qwen')
  assert.equal(next.realtimeProvider, 'dashscope')
  assert.equal(next.language, 'zh-CN')
})

test('preserves drafts outside the section that was applied', () => {
  const draft = {
    ...applied,
    realtimeProvider: 'minicpm-o',
    agentProtocol: 'qwen',
    language: 'en',
  }
  const saved = {
    ...applied,
    agentProtocol: 'qwen',
    backendOwnership: 'external',
  }

  const nextDraft = preserveSettingsDrafts(saved, draft, 'backend')

  assert.equal(nextDraft.agentProtocol, 'qwen')
  assert.equal(nextDraft.backendOwnership, 'external')
  assert.equal(nextDraft.realtimeProvider, 'minicpm-o')
  assert.equal(nextDraft.language, 'en')
})

test('reports dirty state independently for each settings section', () => {
  const draft = { ...applied, realtimeProvider: 'minicpm-o' }

  assert.equal(settingsSectionChanged(applied, draft, 'voice'), true)
  assert.equal(settingsSectionChanged(applied, draft, 'backend'), false)
  assert.equal(settingsSectionChanged(applied, draft, 'app'), false)
})

test('rejects unknown sections and malformed drafts', () => {
  assert.throws(
    () => settingsSectionPatch(applied, 'everything'),
    /invalid settings section/,
  )
  assert.throws(
    () => mergeSettingsSection(applied, null, 'voice'),
    /invalid settings draft/,
  )
})

test('assigns every editable desktop setting to exactly one section', () => {
  const settings = parseSettings('')
  const sectionKeys = ['voice', 'backend', 'app']
    .flatMap(section => Object.keys(settingsSectionPatch(settings, section)))
  const editableKeys = Object.keys(settings)
    .filter(key => key !== 'orbStyle')
    .sort()

  assert.equal(new Set(sectionKeys).size, sectionKeys.length)
  assert.deepEqual(sectionKeys.sort(), editableKeys)
})
