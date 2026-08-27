import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultAnimations,
  frameAtElapsed,
  frameRect,
  resolveAnimations,
  spriteAnimationEventForGatewayEvent,
  spriteAnimationForEvent,
  spriteAnimationForOrbState,
  spritePlaybackSelection,
  spriteGeometry,
} from '../src/sprite-orb.js'

test('maps every orb visual state to a pet animation track', () => {
  const cases = {
    idle: 'idle',
    listening: 'waiting',
    connecting: 'idle',
    processing: 'review',
    occupied: 'idle',
    working: 'running',
    starting: 'running',
    speaking: 'waving',
    waking: 'jumping',
    error: 'failed',
    hidden: 'idle',
    unknown: 'idle',
  }
  const animations = defaultAnimations()
  for (const [state, expected] of Object.entries(cases)) {
    assert.equal(spriteAnimationForOrbState({ state }), expected)
    assert.ok(animations[expected], `track ${expected} must exist`)
  }
})

test('loops sustained voice, startup, and work states', () => {
  assert.deepEqual(spritePlaybackSelection({ state: 'working' }), {
    name: 'running',
    key: 'state:working:running',
    loop: true,
    completion: 'none',
    completionId: null,
    fallback: 'running',
  })
  assert.deepEqual(spritePlaybackSelection({ state: 'idle' }), {
    name: 'idle',
    key: 'state:idle:idle',
    loop: true,
    completion: 'none',
    completionId: null,
    fallback: 'idle',
  })
  assert.deepEqual(spritePlaybackSelection({
    state: 'speaking',
    dragDirection: 'left',
  }), {
    name: 'running-left',
    key: 'drag:left',
    loop: true,
    completion: 'none',
    fallback: 'idle',
  })
  assert.deepEqual(spritePlaybackSelection({ state: 'speaking' }), {
    name: 'waving',
    key: 'state:speaking:waving',
    loop: true,
    completion: 'none',
    completionId: null,
    fallback: 'idle',
  })
  assert.equal(spritePlaybackSelection({ state: 'listening' }).loop, true)
  assert.equal(spritePlaybackSelection({ state: 'starting' }).loop, true)
})

test('plays processing and queued events once, then restores the live base', () => {
  assert.deepEqual(spritePlaybackSelection({
    state: 'working',
    baseWorking: true,
    cue: { id: 7, name: 'failed' },
  }), {
    name: 'failed',
    key: 'cue:7',
    loop: false,
    completion: 'cue',
    completionId: 7,
    fallback: 'running',
  })
  assert.deepEqual(spritePlaybackSelection({
    state: 'processing',
    baseWorking: true,
  }), {
    name: 'review',
    key: 'state:processing:review',
    loop: false,
    completion: 'none',
    completionId: null,
    fallback: 'running',
  })
  assert.deepEqual(spritePlaybackSelection({ state: 'waking' }), {
    name: 'jumping',
    key: 'state:waking:jumping',
    loop: false,
    completion: 'none',
    completionId: null,
    fallback: 'idle',
  })
  assert.equal(spritePlaybackSelection({ state: 'error' }).name, 'failed')
})

test('maps every semantic edge and every task kind without special cases', () => {
  const events = {
    ready: 'jumping',
    wake: 'jumping',
    'task.completed': 'jumping',
    'task.failed': 'failed',
    hover: 'jumping',
    'runtime.failed': 'failed',
  }
  for (const [event, animation] of Object.entries(events)) {
    assert.equal(spriteAnimationForEvent(event), animation)
  }
  for (const kind of ['work', 'control', 'scheduled', 'delegated', 'custom']) {
    assert.equal(spriteAnimationEventForGatewayEvent({
      type: 'task.completed',
      task: { kind },
    }), 'task.completed')
    assert.equal(spriteAnimationEventForGatewayEvent({
      type: 'task.failed',
      task: { kind },
    }), 'task.failed')
  }
  assert.equal(spriteAnimationForEvent('query'), null)
  assert.equal(spriteAnimationEventForGatewayEvent({
    type: 'agent.activity',
    activity: 'query',
  }), null)
  assert.equal(spriteAnimationEventForGatewayEvent({
    type: 'task.running',
    task: { kind: 'work' },
  }), null)
})

test('protected live states are not overwritten by stale one-shot cues', () => {
  for (const [state, name] of [
    ['waking', 'jumping'],
    ['speaking', 'waving'],
    ['listening', 'waiting'],
    ['processing', 'review'],
    ['starting', 'running'],
  ]) {
    const playback = spritePlaybackSelection({
      state,
      cue: { id: 9, name: 'failed' },
    })
    assert.equal(playback.name, name)
    assert.equal(playback.key, `state:${state}:${name}`)
  }
  assert.equal(spritePlaybackSelection({
    state: 'waking',
    cue: { id: 10, name: 'jumping' },
  }).key, 'cue:10')
})

test('only idle loops by default and every action is one-shot', () => {
  const animations = defaultAnimations()
  const idle = animations.idle
  assert.equal(idle.frames.length, 6)
  assert.deepEqual(
    idle.frames.map(frame => frame.durationMs),
    [1680, 660, 660, 840, 840, 1920],
  )
  assert.equal(idle.loopStart, 0)

  const waving = animations.waving
  assert.equal(waving.frames.length, 4)
  assert.equal(waving.loopStart, null)
  assert.equal(waving.fallback, 'idle')
  // 行内帧索引：第 3 行起始 spriteIndex = 24，末帧时长加长。
  assert.equal(waving.frames[0].spriteIndex, 24)
  assert.equal(waving.frames[3].durationMs, 280)

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
  ]) {
    assert.ok(animations[name], `default track ${name} must exist`)
    assert.ok(animations[animations[name].fallback])
    assert.equal(
      animations[name].loopStart,
      name === 'idle' ? 0 : null,
      `${name} lifecycle`,
    )
  }
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

test('merges frame/fps overrides and ignores skin-owned lifecycle fields', () => {
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
  assert.equal(merged.waving.fallback, 'idle')
  // 未覆盖的轨道保持默认。
  assert.equal(merged.idle.frames.length, 6)

  assert.throws(() => resolveAnimations({
    animations: { 'spin': { frames: [] } },
  }, 72), /至少要包含一帧/)
  assert.throws(() => resolveAnimations({
    animations: { 'spin': { frames: [0], fps: 0 } },
  }, 72), /fps 非法/)
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
