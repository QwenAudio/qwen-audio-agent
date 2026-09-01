import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { CustomSkillStore } from '../custom-skills/store.mjs'

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'qwen-cockpit-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let timestamp = Date.parse('2026-09-01T00:00:00.000Z')
  return new CustomSkillStore({
    root,
    now: () => new Date(timestamp++),
  })
}

test('persists, updates and deletes cockpit-scoped custom skills', async t => {
  const store = await fixture(t)
  const created = await store.upsert('car-one', {
    name: '下班回家',
    description: '回家路线和音乐',
    instructions: '1. 导航回家。\n2. 播放音乐。',
  })
  assert.equal((await store.list('car-one')).length, 1)
  assert.equal((await store.list('car-two')).length, 0)

  const updated = await store.upsert('car-one', {
    name: '下班回家',
    description: '回家路线、音乐和空调',
    instructions: '1. 导航回家。\n2. 播放音乐。\n3. 调节空调。',
  })
  assert.equal(updated.id, created.id)
  assert.equal(updated.createdAt, created.createdAt)
  assert.notEqual(updated.updatedAt, created.updatedAt)
  assert.match((await store.get('car-one', '下班回家')).instructions, /调节空调/u)

  assert.equal((await store.delete('car-one', created.id)).name, '下班回家')
  assert.deepEqual(await store.list('car-one'), [])
})

test('contains identifiers and ignores damaged records', async t => {
  const store = await fixture(t)
  await assert.rejects(
    store.upsert('../../escape', {
      name: '',
      description: 'x',
      instructions: 'x',
    }),
    /skill name is required/u,
  )
  await store.upsert('../../escape', {
    name: '安全技能',
    description: '验证目录隔离',
    instructions: '查询车辆状态。',
  })
  const [cockpitDirectory] = await readdir(store.root)
  await writeFile(resolve(store.root, cockpitDirectory, 'damaged.json'), '{broken', 'utf8')
  assert.equal((await store.list('../../escape')).length, 1)
  assert.equal(await store.get('../../escape', '../../not-a-file'), null)
})
