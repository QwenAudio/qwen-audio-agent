import assert from 'node:assert/strict'
import test from 'node:test'
import { FrontendMemoryStore } from '../src/conversation/frontend-memory.mjs'
import { ProfiledMemoryStore } from '../src/conversation/profiled-memory-store.mjs'

function harness({ withProfile = true } = {}) {
  const memoryStore = new FrontendMemoryStore()
  const profileEntries = []
  const userProfile = withProfile
    ? {
        list: () => [{
          id: 'user_profile',
          scope: 'profile',
          content: '# USER\n\n- 称呼：老大',
          editable: false,
        }],
        remember: content => {
          const entry = {
            id: `profile_${profileEntries.length}`,
            scope: 'profile',
            content,
            editable: true,
          }
          profileEntries.push(entry)
          return entry
        },
        replace: () => ({ replaced: 0, memory: null }),
        forget: () => 0,
      }
    : null
  return {
    memoryStore,
    store: new ProfiledMemoryStore({ memoryStore, userProfile }),
  }
}

test('routes each scope to its own backing store', () => {
  const { store } = harness()
  const profile = store.remember('owner', { scope: 'profile', content: '称呼：老大' })
  const fact = store.remember('owner', { scope: 'long_term', content: '用户喜欢苹果' })
  const rule = store.remember('owner', { scope: 'rules', content: '回复默认先给结论' })

  assert.equal(profile.scope, 'profile')
  assert.equal(fact.scope, 'long_term')
  assert.equal(rule.scope, 'rules')

  assert.deepEqual(
    store.list('owner', { scope: 'rules' }).map(entry => entry.content),
    ['回复默认先给结论'],
  )
  assert.deepEqual(
    store.list('owner', { scope: 'long_term' }).map(entry => entry.content),
    ['用户喜欢苹果'],
  )
  assert.deepEqual(
    store.list('owner', { scope: 'all' }).map(entry => entry.scope).sort(),
    ['long_term', 'profile', 'rules'].sort(),
  )
})

test('keeps every stored rule inside a full combined listing', () => {
  const { store } = harness({ withProfile: false })
  for (let index = 0; index < 16; index += 1) {
    store.remember('owner', { scope: 'rules', content: `约定-${index}` })
  }
  for (let index = 0; index < 32; index += 1) {
    store.remember('owner', { scope: 'long_term', content: `事实-${index}` })
  }

  const all = store.list('owner', { limit: 64 })
  assert.equal(all.filter(entry => entry.scope === 'rules').length, 16)
})

test('forgets one scope without touching the others', () => {
  const { store } = harness({ withProfile: false })
  store.remember('owner', { scope: 'rules', content: '叫我阿豪' })
  store.remember('owner', { scope: 'long_term', content: '用户喜欢苹果' })

  assert.equal(store.forget('owner', { scope: 'rules', all: true }), 1)
  assert.deepEqual(
    store.list('owner', { scope: 'all' }).map(entry => entry.content),
    ['用户喜欢苹果'],
  )
})

test('rejects writes to the combined scope', () => {
  const { store } = harness()
  assert.throws(
    () => store.remember('owner', { scope: 'all', content: '事实' }),
    /concrete memory scope/,
  )
  assert.throws(
    () => store.replace('owner', { scope: 'all', ids: ['mem_one'], content: '事实' }),
    /concrete memory scope/,
  )
})
