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

test('persists structured event rules and returns their fields to the catalog', async t => {
  const store = await fixture(t)
  const rule = await store.upsert('car-one', {
    name: '低温提醒',
    description: '主驾空调低温时提醒保暖',
    trigger: { type: 'vehicle_temperature', max: 19 },
    reminder: '当前温度较低，请注意保暖',
    instructions: 'arbitrary user code is never evaluated',
  })
  assert.equal(rule.trigger.field, 'acTemp')
  assert.match(rule.instructions, /19°C及以下/u)
  assert.doesNotMatch(rule.instructions, /arbitrary user code/u)
  const reloaded = new CustomSkillStore({ root: store.root })
  assert.deepEqual((await reloaded.list('car-one'))[0].trigger, rule.trigger)
  assert.equal((await reloaded.get('car-one', rule.id)).reminder, rule.reminder)
  assert.equal((await reloaded.list('car-one'))[0].kind, 'event')
  assert.deepEqual(await reloaded.list('car-two'), [])
})

test('bounds event rules instead of accepting arbitrary predicates or user code', async t => {
  const store = await fixture(t)
  const base = {
    name: '低温提醒', description: '规则验证', kind: 'event', reminder: '注意保暖',
  }
  for (const trigger of [
    { type: 'javascript', max: 19 },
    { type: 'vehicle_temperature', field: 'vehicle.engine', max: 19 },
    { type: 'vehicle_temperature' },
    { type: 'vehicle_temperature', max: '19' },
    { type: 'vehicle_temperature', min: 21, max: 19 },
    { type: 'vehicle_temperature', max: 40 },
    { type: 'vehicle_temperature', max: 19, evaluate: 'return true' },
  ]) {
    await assert.rejects(store.upsert('car-one', { ...base, trigger }), TypeError)
  }
  await assert.rejects(store.upsert('car-one', {
    ...base, trigger: { type: 'vehicle_temperature', max: 19 }, reminder: '',
  }), /skill reminder is required/u)
  assert.deepEqual(await store.list('car-one'), [])
})

test('keeps legacy workflow records readable without an explicit kind', async t => {
  const store = await fixture(t)
  const skill = await store.upsert('car-one', {
    name: '舒适出发', description: '温度和音乐', instructions: '空调22度，然后音乐音量3。',
  })
  const [directory] = await readdir(store.root)
  delete skill.kind
  await writeFile(resolve(store.root, directory, `${skill.id}.json`), JSON.stringify(skill))
  assert.equal((await store.get('car-one', skill.id)).kind, 'workflow')
  assert.equal((await store.list('car-one'))[0].kind, 'workflow')
  assert.equal((await store.get('car-one', skill.id)).instructions, skill.instructions)
})
