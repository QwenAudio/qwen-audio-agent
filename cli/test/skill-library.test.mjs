import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  addSkills,
  ensureBackendSkills,
  listSkills,
  presentInstallerAgents,
  readSkillLock,
  removeSkill,
  runSkillsCli,
  skillsCliPackage,
  updateSkills,
} from '../../shared/skill-library.mjs'
import {
  backendDefinitions,
  backendSkillsSpec,
  skillsInstallerAgents,
  validateBackendSkillsSpec,
} from '../../shared/backend-catalog.mjs'

function fakeSpawn({ status = 0, stdout = '', stderr = '', error } = {}) {
  const calls = []
  const spawn = args => {
    calls.push(args)
    return { status, stdout, stderr, error }
  }
  return { calls, spawn }
}

test('runs the pinned skills.sh package through npx argv', () => {
  const target = fakeSpawn({ stdout: 'ok\n' })
  const result = runSkillsCli(['list', '-g'], { spawn: target.spawn })
  assert.deepEqual(target.calls, [['-y', skillsCliPackage(), 'list', '-g']])
  assert.equal(result.stdout, 'ok\n')

  // 版本可用环境变量覆盖（对齐 *_PACKAGE 惯例）。
  assert.equal(
    skillsCliPackage({ QWEN_AUDIO_AGENT_SKILLS_CLI_PACKAGE: 'skills@9.9.9' }),
    'skills@9.9.9',
  )
  assert.match(skillsCliPackage({}), /^skills@\d/)
})

test('surfaces skills.sh failures with stderr detail', () => {
  const failed = fakeSpawn({ status: 1, stderr: 'repository not found' })
  assert.throws(
    () => runSkillsCli(['add', 'missing/repo'], { spawn: failed.spawn }),
    /repository not found/,
  )
  const broken = fakeSpawn({ error: new Error('spawn npx ENOENT') })
  assert.throws(
    () => runSkillsCli(['list'], { spawn: broken.spawn }),
    /skills CLI 启动失败/,
  )
})

test('installs to every backend installer agent explicitly', () => {
  const target = fakeSpawn({ stdout: 'installed\n' })
  addSkills('alirezarezvani/claude-skills', {
    skills: ['skill-security-auditor', 'playwright-pro'],
    spawn: target.spawn,
  })
  const args = target.calls[0]
  assert.equal(args[2], 'add')
  assert.equal(args[3], 'alirezarezvani/claude-skills')
  // 技能多选。
  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === '--skill'),
    ['skill-security-auditor', 'playwright-pro'],
  )
  // 全局安装、拷贝模式（规避 symlink 兼容性问题）、非交互。
  for (const flag of ['-g', '--copy', '-y']) {
    assert.ok(args.includes(flag), `missing ${flag}`)
  }
  // 缺省回退 catalog installer 全名单。
  const agents = args.filter((value, index) => args[index - 1] === '-a')
  assert.deepEqual(agents.sort(), [...skillsInstallerAgents()].sort())
  assert.ok(agents.includes('hermes-agent'))
  assert.ok(agents.includes('openclaw'))
  assert.ok(agents.includes('pi'))
  // deepseek 暂无 skills.sh 安装器（经 ~/.agents/skills 被动受益）。
  assert.equal(agents.length, 10)

  // 传入 agents 时只装给指定后台（“本机存在 ∪ 当前”名单）。
  const narrowed = fakeSpawn({ stdout: 'installed\n' })
  addSkills('owner/repo', {
    skills: ['review'],
    agents: ['claude-code'],
    spawn: narrowed.spawn,
  })
  assert.deepEqual(
    narrowed.calls[0].filter((value, index) => (
      narrowed.calls[0][index - 1] === '-a'
    )),
    ['claude-code'],
  )
})

test('lists remote skills without installing', () => {
  const target = fakeSpawn({ stdout: 'skill-a\nskill-b\n' })
  const result = addSkills('vercel-labs/skills', {
    list: true,
    spawn: target.spawn,
  })
  assert.deepEqual(
    target.calls,
    [['-y', skillsCliPackage(), 'add', 'vercel-labs/skills', '--list']],
  )
  assert.match(result.stdout, /skill-a/)
})

test('requires --skill for installs and a non-empty source', () => {
  const target = fakeSpawn()
  assert.throws(
    () => addSkills('owner/repo', { spawn: target.spawn }),
    /--skill/,
  )
  assert.throws(() => addSkills('', { spawn: target.spawn }), /来源/)
  assert.equal(target.calls.length, 0)
})

test('passes list, remove and update straight through in global scope', () => {
  const target = fakeSpawn({ stdout: 'done\n' })
  listSkills({ spawn: target.spawn })
  removeSkill('pdf-tools', { spawn: target.spawn })
  updateSkills({ spawn: target.spawn })
  assert.deepEqual(target.calls.map(args => args.slice(2)), [
    ['list', '-g'],
    ['remove', 'pdf-tools', '-g', '-y'],
    ['update', '-g'],
  ])
  assert.throws(() => removeSkill('', { spawn: target.spawn }), /名称/)
})

test('every backend definition declares its skills contract', () => {
  for (const definition of backendDefinitions()) {
    assert.doesNotThrow(() => validateBackendSkillsSpec(definition))
  }
  // acp 是通用接入方式无技能约定；deepseek 暂无 skills.sh 安装器。
  assert.equal(backendSkillsSpec('acp'), null)
  assert.deepEqual(backendSkillsSpec('deepseek'), { installer: null })
  assert.deepEqual(backendSkillsSpec('claude'), { installer: 'claude-code' })
  assert.deepEqual(backendSkillsSpec('pi'), { installer: 'pi' })

  assert.throws(
    () => validateBackendSkillsSpec({ id: 'future' }),
    /缺少 skills 声明/,
  )
  for (const installer of ['', 'Bad Name', 'UPPER', 'has space', '-lead', 'a--b']) {
    assert.throws(
      () => validateBackendSkillsSpec({ id: 'future', skills: { installer } }),
      /installer 无效/,
    )
  }
  assert.doesNotThrow(() => validateBackendSkillsSpec({
    id: 'future',
    skills: { installer: 'new-agent-cli' },
  }))
})

function lockFixture(skills) {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-skill-home-'))
  if (skills) {
    mkdirSync(resolve(homeDirectory, '.agents'), { recursive: true })
    writeFileSync(
      resolve(homeDirectory, '.agents/.skill-lock.json'),
      JSON.stringify({ version: 3, skills }),
    )
  }
  return homeDirectory
}

function placeSkill(homeDirectory, directory, name) {
  const skillDirectory = resolve(homeDirectory, directory, name)
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(resolve(skillDirectory, 'SKILL.md'), '---\nname: x\n---\n')
}

test('reads the skills.sh lockfile defensively', () => {
  const empty = lockFixture(null)
  assert.deepEqual(readSkillLock({ homeDirectory: empty }), {})
  const filled = lockFixture({ review: { source: 'owner/repo' } })
  assert.deepEqual(
    Object.keys(readSkillLock({ homeDirectory: filled })),
    ['review'],
  )
})

test('backfills missing skills for the active backend synchronously', () => {
  const homeDirectory = lockFixture({
    review: { source: 'owner/repo' },
    'pdf-tools': { source: 'owner/repo' },
    remote: { sourceUrl: 'https://github.com/o/r.git' },
  })
  // 当前后台（qwen → ~/.qwen/skills）已有 review，缺另外两个。
  placeSkill(homeDirectory, '.qwen/skills', 'review')

  const target = fakeSpawn({ stdout: 'ok\n' })
  const result = ensureBackendSkills({
    protocol: 'qwen',
    homeDirectory,
    spawn: target.spawn,
  })
  assert.equal(result.refreshed, true)
  assert.equal(result.installer, 'qwen-code')
  assert.deepEqual(result.installed.sort(), ['pdf-tools', 'remote'])
  // 按来源分组：两个来源各一条命令，均只面向当前后台。
  assert.equal(target.calls.length, 2)
  for (const args of target.calls) {
    assert.deepEqual(
      args.filter((value, index) => args[index - 1] === '-a'),
      ['qwen-code'],
    )
  }
  assert.deepEqual(
    target.calls[0].filter((value, index) => (
      target.calls[0][index - 1] === '--skill'
    )),
    ['pdf-tools'],
  )
})

test('isolates per-source backfill failures with cleanup guidance', () => {
  const homeDirectory = lockFixture({
    gone: { source: 'owner/stale-repo' },
    review: { source: 'owner/live-repo' },
  })
  const calls = []
  const spawn = args => {
    calls.push(args)
    // 旧源里的技能已被上游移除 → 该源失败；另一源正常。
    return args.includes('owner/stale-repo')
      ? { status: 1, stdout: '', stderr: 'No matching skills found' }
      : { status: 0, stdout: 'ok\n', stderr: '' }
  }
  const result = ensureBackendSkills({ protocol: 'claude', homeDirectory, spawn })
  assert.equal(result.refreshed, true)
  assert.deepEqual(result.installed, ['review'])
  assert.equal(result.failures.length, 1)
  assert.deepEqual(result.failures[0].names, ['gone'])
  assert.match(result.failures[0].hint, /skill remove/)
  assert.equal(calls.length, 2)
})

test('skips backfill when nothing is missing or unsupported', () => {
  const target = fakeSpawn()
  // 无安装器（deepseek/纯前台）。
  assert.equal(
    ensureBackendSkills({ protocol: 'deepseek', spawn: target.spawn }).reason,
    'no-installer',
  )
  assert.equal(
    ensureBackendSkills({ protocol: '', spawn: target.spawn }).reason,
    'no-installer',
  )
  // lock 为空。
  const empty = lockFixture(null)
  assert.equal(
    ensureBackendSkills({
      protocol: 'qwen',
      homeDirectory: empty,
      spawn: target.spawn,
    }).reason,
    'up-to-date',
  )
  // 技能齐全。
  const ready = lockFixture({ review: { source: 'owner/repo' } })
  placeSkill(ready, '.claude/skills', 'review')
  assert.equal(
    ensureBackendSkills({
      protocol: 'claude',
      homeDirectory: ready,
      spawn: target.spawn,
    }).reason,
    'up-to-date',
  )
  assert.equal(target.calls.length, 0)
})

test('uses Pi\'s global skill directory for backfill checks', () => {
  const homeDirectory = lockFixture({ review: { source: 'owner/repo' } })
  placeSkill(homeDirectory, '.pi/agent/skills', 'review')
  const target = fakeSpawn()
  assert.equal(
    ensureBackendSkills({ protocol: 'pi', homeDirectory, spawn: target.spawn }).reason,
    'up-to-date',
  )
  assert.equal(target.calls.length, 0)
})

test('builds the present-backend installer list with fallback', () => {
  // 检测到的后台 ∪ 当前后台，去重且排除无安装器后台。
  assert.deepEqual(
    presentInstallerAgents({
      readyBackends: ['claude', 'opencode', 'deepseek', 'acp'],
      currentProtocol: 'opencode',
    }).sort(),
    ['claude-code', 'opencode'],
  )
  // 当前后台未装 CLI 也必须在名单（openclaw npx 托管场景）。
  assert.deepEqual(
    presentInstallerAgents({ readyBackends: [], currentProtocol: 'openclaw' }),
    ['openclaw'],
  )
  // 一个都没有时回退全名单。
  assert.deepEqual(
    presentInstallerAgents({ readyBackends: [], currentProtocol: '' }).sort(),
    [...skillsInstallerAgents()].sort(),
  )
})
