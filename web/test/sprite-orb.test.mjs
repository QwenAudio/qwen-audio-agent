import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultAnimations,
  frameAtElapsed,
  frameRect,
  resolveAnimations,
  spriteAnimationForOrbState,
  spriteGeometry,
} from '../src/sprite-orb.js'

test('maps every orb visual state to a pet animation track', () => {
  const cases = {
    idle: 'idle',
    listening: 'waiting',
    connecting: 'waiting',
    thinking: 'review',
    occupied: 'running',
    working: 'working',
    attention: 'attention',
    speaking: 'waving',
    waking: 'waving',
    error: 'failed',
    hidden: 'idle',
    unknown: 'idle',
  }
  const animations = defaultAnimations()
  for (const [state, expected] of Object.entries(cases)) {
    assert.equal(spriteAnimationForOrbState({ state }), expected)
    assert.ok(animations[expected], `track ${expected} must exist`)
  }
  // 拖拽修饰优先于语音状态。
  assert.equal(
    spriteAnimationForOrbState({ state: 'speaking', dragging: true }),
    'running-right',
  )
})

test('default tracks repeat three times then settle into the idle loop', () => {
  const animations = defaultAnimations()
  const idle = animations.idle
  assert.equal(idle.frames.length, 6)
  assert.deepEqual(
    idle.frames.map(frame => frame.durationMs),
    [1680, 660, 660, 840, 840, 1920],
  )
  assert.equal(idle.loopStart, 0)

  const waving = animations.waving
  // waving 行 4 帧重复 3 遍 + idle 6 帧沉降段。
  assert.equal(waving.frames.length, 4 * 3 + 6)
  assert.equal(waving.loopStart, 12)
  assert.equal(waving.fallback, 'idle')
  // 行内帧索引：第 3 行起始 spriteIndex = 24，末帧时长加长。
  assert.equal(waving.frames[0].spriteIndex, 24)
  assert.equal(waving.frames[3].durationMs, 280)
  // 沉降段引用 idle 行帧。
  assert.equal(waving.frames[12].spriteIndex, 0)

  for (const name of [
    'idle',
    'running-right',
    'running-left',
    'waving',
    'jumping',
    'failed',
    'waiting',
    'running',
    'review',
    'working',
    'attention',
  ]) {
    assert.ok(animations[name], `default track ${name} must exist`)
    assert.ok(animations[animations[name].fallback])
  }
})

test('the working track loops the running-left row without settling', () => {
  const working = defaultAnimations().working
  // 仅含第 2 行的 8 帧，无 idle 沉降段，持续循环。
  assert.equal(working.frames.length, 8)
  assert.equal(working.loopStart, 0)
  assert.equal(working.fallback, 'idle')
  assert.equal(working.frames[0].spriteIndex, 16)
  assert.equal(working.frames[7].spriteIndex, 23)
  assert.equal(working.frames[7].durationMs, 220)
})

test('the attention track loops the jumping row to demand a decision', () => {
  const attention = defaultAnimations().attention
  // 仅含第 4 行（jumping）的 5 帧，持续循环不沉降。
  assert.equal(attention.frames.length, 5)
  assert.equal(attention.loopStart, 0)
  assert.equal(attention.fallback, 'idle')
  assert.equal(attention.frames[0].spriteIndex, 32)
  assert.equal(attention.frames[4].spriteIndex, 36)
  assert.equal(attention.frames[4].durationMs, 280)
})

test('resolves elapsed time to frames across intro, loop, and one-shot tracks', () => {
  const looping = {
    frames: [
      { spriteIndex: 10, durationMs: 100 },
      { spriteIndex: 11, durationMs: 100 },
      { spriteIndex: 12, durationMs: 200 },
    ],
    loopStart: 1,
    fallback: 'idle',
  }
  assert.deepEqual(frameAtElapsed(looping, 0), {
    spriteIndex: 10,
    remainingMs: 100,
  })
  assert.deepEqual(frameAtElapsed(looping, 150), {
    spriteIndex: 11,
    remainingMs: 50,
  })
  // 播完整段后从 loopStart 段循环：总长 400，循环段 300。
  assert.deepEqual(frameAtElapsed(looping, 400), {
    spriteIndex: 11,
    remainingMs: 100,
  })
  // 850 → 循环内位置 100 + (450 % 300) = 250，落在第三帧。
  assert.deepEqual(frameAtElapsed(looping, 850), {
    spriteIndex: 12,
    remainingMs: 150,
  })

  const oneShot = {
    frames: [{ spriteIndex: 0, durationMs: 100 }],
    loopStart: null,
    fallback: 'idle',
  }
  assert.deepEqual(frameAtElapsed(oneShot, 50), {
    spriteIndex: 0,
    remainingMs: 50,
  })
  // one-shot 播完返回 null，由调用方交棒 fallback。
  assert.equal(frameAtElapsed(oneShot, 100), null)
})

test('merges pet.json animation overrides and validates them', () => {
  const merged = resolveAnimations({
    animations: {
      'waving': { frames: [1, 2], fps: 10, loop: false, fallback: 'waiting' },
    },
  }, 72)
  assert.deepEqual(merged.waving.frames, [
    { spriteIndex: 1, durationMs: 100 },
    { spriteIndex: 2, durationMs: 100 },
  ])
  assert.equal(merged.waving.loopStart, null)
  assert.equal(merged.waving.fallback, 'waiting')
  // 未覆盖的轨道保持默认。
  assert.equal(merged.idle.frames.length, 6)

  assert.throws(() => resolveAnimations({
    animations: { 'spin': { frames: [] } },
  }, 72), /至少要包含一帧/)
  assert.throws(() => resolveAnimations({
    animations: { 'spin': { frames: [0], fps: 0 } },
  }, 72), /fps 非法/)
  assert.throws(() => resolveAnimations({
    animations: { 'spin': { frames: [0], fallback: 'nope' } },
  }, 72), /fallback 不存在/)
  // 默认轨道引用超出小网格帧数时同样失败（与 Codex 行为一致）。
  assert.throws(() => resolveAnimations({}, 8), /越界的帧索引/)
})

test('derives sprite geometry from the frame spec with v1/v2 defaults', () => {
  assert.deepEqual(spriteGeometry({}), {
    width: 192,
    height: 208,
    columns: 8,
    rows: 9,
    frameCount: 72,
  })
  assert.equal(spriteGeometry({ spriteVersionNumber: 2 }).rows, 11)
  assert.deepEqual(spriteGeometry({
    frame: { width: 64, height: 64, columns: 4, rows: 2 },
  }), {
    width: 64,
    height: 64,
    columns: 4,
    rows: 2,
    frameCount: 8,
  })
  assert.equal(spriteGeometry({ frame: { width: 0 } }), null)

  const geometry = spriteGeometry({})
  assert.deepEqual(frameRect(geometry, 0), {
    x: 0,
    y: 0,
    width: 192,
    height: 208,
  })
  // 第 3 行（waving）第 0 帧：spriteIndex 24。
  assert.deepEqual(frameRect(geometry, 24), {
    x: 0,
    y: 3 * 208,
    width: 192,
    height: 208,
  })
  assert.deepEqual(frameRect(geometry, 26).x, 2 * 192)
})
