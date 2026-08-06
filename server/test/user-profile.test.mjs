import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { ProfiledMemoryStore } from '../src/conversation/profiled-memory-store.mjs'
import { UserProfile } from '../src/conversation/user-profile.mjs'

function profileFixture(content) {
  const directory = mkdtempSync(resolve(tmpdir(), 'qwaudio-profile-'))
  const filePath = resolve(directory, 'USER.md')
  writeFileSync(filePath, content)
  return filePath
}

test('reads user-maintained profile data without treating the empty template as memory', () => {
  const empty = new UserProfile({
    filePath: profileFixture('# USER\n\n## 基本信息\n\n- 称呼：\n- \n'),
  })
  const filled = new UserProfile({
    filePath: profileFixture('# USER\n\n- 称呼：老大\n'),
  })

  assert.equal(empty.read(), '')
  assert.match(filled.read(), /称呼：老大/)
})

test('maintains a safe editable profile section without overwriting manual content', () => {
  const filePath = profileFixture('# USER\n\n- 手写信息：保留我\n')
  const profile = new UserProfile({ filePath })
  const entry = profile.remember('用户希望被称为老大')
  const duplicate = profile.remember('用户希望被称为老大')

  assert.equal(duplicate.id, entry.id)
  assert.equal(profile.list().length, 2)
  assert.equal(profile.list()[0].editable, false)
  assert.equal(profile.list()[1].editable, true)
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }

  assert.equal(profile.forget({ query: '老大' }), 1)
  const content = readFileSync(filePath, 'utf8')
  assert.match(content, /手写信息：保留我/)
  assert.doesNotMatch(content, /用户希望被称为老大/)
})

test('clear-all only removes managed profile entries', () => {
  const filePath = profileFixture('# USER\n\n- 手写信息：保留我\n')
  const profile = new UserProfile({ filePath })
  profile.remember('偏好简洁回答')
  profile.remember('主要使用中文')

  assert.equal(profile.forget({ all: true }), 2)
  assert.match(readFileSync(filePath, 'utf8'), /手写信息：保留我/)
  assert.equal(profile.list().length, 1)
})

test('replaces managed profile text by id and protects manual profile content', () => {
  const filePath = profileFixture('# USER\n\n- 手写称呼：不可改\n')
  const profile = new UserProfile({ filePath })
  const old = profile.remember('用户希望被称为老大')

  const result = profile.replace({
    ids: ['user_profile', old.id],
    content: '用户希望被称为老板',
  })

  assert.equal(result.replaced, 1)
  assert.equal(result.memory.content, '用户希望被称为老板')
  const content = readFileSync(filePath, 'utf8')
  assert.match(content, /手写称呼：不可改/)
  assert.doesNotMatch(content, /用户希望被称为老大/)
  assert.match(content, /用户希望被称为老板/)
})

test('combines profile and owner-scoped long-term memory', () => {
  const entries = new Map([
    ['owner-a', [{
      id: 'mem_a',
      scope: 'facts',
      content: '喜欢苹果',
      updated_at: 1,
      editable: true,
    }]],
    ['owner-b', [{
      id: 'mem_b',
      scope: 'facts',
      content: '喜欢香蕉',
      updated_at: 1,
      editable: true,
    }]],
  ])
  const dynamic = {
    list: ownerId => entries.get(ownerId) || [],
    remember: (ownerId, content) => ({ ownerId, content }),
    replace: (ownerId, input) => ({ ownerId, ...input }),
    forget: () => 1,
    health: () => ({ ok: true, owners: 2 }),
  }
  const store = new ProfiledMemoryStore({
    memoryStore: dynamic,
    userProfile: new UserProfile({
      filePath: profileFixture('# USER\n\n- 称呼：老大\n'),
    }),
  })

  const memories = store.list('owner-a')
  assert.equal(memories[0].scope, 'profile')
  assert.equal(memories[0].editable, false)
  assert.match(memories[0].content, /称呼：老大/)
  assert.equal(memories[1].content, '喜欢苹果')
  assert.equal(store.list('owner-a', { scope: 'profile' }).length, 1)
  assert.deepEqual(
    store.remember('owner-a', { scope: 'facts', content: '喜欢梨' }),
    { ownerId: 'owner-a', content: '喜欢梨' },
  )
  assert.deepEqual(
    store.replace('owner-a', {
      scope: 'facts',
      ids: ['mem_a'],
      content: '喜欢梨',
    }),
    {
      ownerId: 'owner-a',
      scope: 'facts',
      ids: ['mem_a'],
      content: '喜欢梨',
    },
  )
  assert.equal(store.forget('owner-a', {
    scope: 'facts',
    query: '喜欢苹果',
  }), 1)
})

test('a missing profile never prevents the voice service from running', () => {
  const profile = new UserProfile({ filePath: '/missing/qwaudio/USER.md' })
  assert.equal(profile.read(), '')
  assert.equal(profile.health().ok, true)
})
