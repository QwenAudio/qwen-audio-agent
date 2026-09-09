import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./sync-github.sh', import.meta.url))
const credentialScript = fileURLToPath(new URL('./git-credential.sh', import.meta.url))
const targetUrl = 'https://gitlab.example.test/example/project.git'
const syncIdentity = { SYNC_COMMIT_NAME: 'Sync Bot', SYNC_COMMIT_EMAIL: 'sync-bot@example.test' }
const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input,
    env: { ...process.env, ...identity } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function commit(cwd, files, message = 'fixture') {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content)
  git(cwd, ['add', '.'])
  const tree = git(cwd, ['write-tree'])
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8' })
  const parents = head.status === 0 ? ['-p', head.stdout.trim()] : []
  const sha = git(cwd, ['commit-tree', tree, ...parents], message)
  git(cwd, ['update-ref', 'refs/heads/main', sha])
  return sha
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-sync-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const target = join(root, 'target.git')
  const worker = join(root, 'worker')
  mkdirSync(source)
  git(source, ['init', '-b', 'main'])
  const baseline = commit(source, { 'file.txt': 'initial\n' })
  git(root, ['clone', '--bare', source, target])
  git(root, ['clone', target, worker])
  return { root, source, target, worker, baseline,
    run(extra = {}) {
      return spawnSync('bash', [script], { cwd: worker, encoding: 'utf8', env: {
        ...process.env, ...syncIdentity, SYNC_TARGET_URL: targetUrl,
        SYNC_GITLAB_USERNAME: 'sync-bot', SYNC_TARGET_REMOTE: 'origin',
        SYNC_SOURCE_URL: source, SYNC_BOOTSTRAP_SOURCE: baseline,
        SYNC_BOOTSTRAP_TARGET: baseline, SYNC_DRY_RUN: 'false', SYNC_GITLAB_TOKEN: '', ...extra,
      } })
    },
    head() { return git(root, ['--git-dir', target, 'rev-parse', 'main']) },
  }
}

test('no-op creates no commit; several source commits become one ordinary snapshot', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  assert.equal(f.head(), f.baseline)
  commit(f.source, { 'file.txt': 'second\n' })
  const latest = commit(f.source, { 'file.txt': 'third\n', 'new.txt': 'added' })
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  const target = f.head()
  assert.equal(git(f.root, ['--git-dir', f.target, 'rev-parse', `${target}^`]), f.baseline)
  assert.equal(git(f.root, ['--git-dir', f.target, 'rev-parse', `${target}^{tree}`]),
    git(f.source, ['rev-parse', `${latest}^{tree}`]))
  assert.equal(git(f.root, ['--git-dir', f.target, 'show', '-s', '--format=%an|%ae|%cn|%ce', target]),
    'Sync Bot|sync-bot@example.test|Sync Bot|sync-bot@example.test')
  assert.equal(f.run({ SYNC_BOOTSTRAP_SOURCE: '', SYNC_BOOTSTRAP_TARGET: '' }).status, 0)
  assert.equal(f.head(), target)
  commit(f.source, { 'file.txt': 'fourth\n' })
  assert.equal(f.run().status, 0)
  assert.equal(git(f.root, ['--git-dir', f.target, 'rev-parse', 'main^']), target)
})

test('dry run validates without pushing', t => {
  const f = fixture(t)
  commit(f.source, { 'file.txt': 'updated\n' })
  const result = f.run({ SYNC_DRY_RUN: 'true' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Dry run passed/)
  assert.match(result.stdout, /\[1\/4\] Fetch GitHub main/)
  assert.match(result.stdout, /\[4\/4\] Validate GitLab push permission/)
  assert.equal(f.head(), f.baseline)
})

test('independent destination edits stop synchronization', t => {
  const f = fixture(t)
  const local = commit(f.worker, { 'local.txt': 'must survive' })
  git(f.worker, ['push', 'origin', 'main'])
  commit(f.source, { 'file.txt': 'updated\n' })
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unrecognized commit/)
  assert.equal(f.head(), local)
})

test('copied snapshot metadata cannot hide independent edits', t => {
  const f = fixture(t)
  const message = `manual edit\n\nGitHub-Repository: ${f.source}\nGitHub-Commit: ${f.baseline}\n`
  const local = commit(f.worker, { 'local.txt': 'must survive' }, message)
  git(f.worker, ['push', 'origin', 'main'])
  commit(f.source, { 'file.txt': 'updated\n' })
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /changes outside/)
  assert.equal(f.head(), local)
})

test('rewritten source history is rejected', t => {
  const f = fixture(t)
  const orphan = git(f.source, ['commit-tree', git(f.source, ['rev-parse', 'HEAD^{tree}'])], 'new root')
  git(f.source, ['update-ref', 'refs/heads/main', orphan])
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /history diverged/)
  assert.equal(f.head(), f.baseline)
})

test('credential helper only serves the exact HTTPS destination and never stores credentials', () => {
  const token = 'test-only-write-token'
  const invoke = (operation, host, path, protocol = 'https', secret = token) =>
    spawnSync('bash', [credentialScript, operation], { encoding: 'utf8',
      input: `protocol=${protocol}\nhost=${host}\npath=${path}\n\n`,
      env: { ...process.env, SYNC_TARGET_URL: targetUrl,
        SYNC_GITLAB_USERNAME: 'sync-bot', SYNC_GITLAB_TOKEN: secret } })
  const allowed = invoke('get', 'gitlab.example.test', 'example/project.git')
  assert.equal(allowed.status, 0)
  assert.equal(allowed.stderr, '')
  assert.equal(allowed.stdout, `username=sync-bot\npassword=${token}\n`)
  for (const args of [
    ['get', 'github.example.test', 'example/project.git'],
    ['get', 'gitlab.example.test', 'another/repository.git'],
    ['get', 'gitlab.example.test', 'example/project.git', 'http'],
    ['get', 'gitlab.example.test', 'example/project.git', 'https', ''],
    ['get', 'gitlab.example.test', 'example/project.git', 'https', 'token\nextra=value'],
    ['store', 'gitlab.example.test', 'example/project.git'],
    ['erase', 'gitlab.example.test', 'example/project.git'],
  ]) {
    const denied = invoke(...args)
    assert.equal(denied.status, 0)
    assert.equal(denied.stdout, '')
    assert.equal(denied.stderr, '')
  }
})

test('CI strips credentials from both remote URLs before network operations', t => {
  const f = fixture(t)
  const secret = 'test-only-old-credential'
  const credentialUrl = `https://sync-bot:${secret}@gitlab.example.test/example/project.git`
  git(f.worker, ['remote', 'set-url', 'origin', credentialUrl])
  git(f.worker, ['remote', 'set-url', '--push', 'origin', credentialUrl])
  const result = f.run({ SYNC_GITLAB_TOKEN: 'test-only-new-credential',
    SYNC_SOURCE_URL: join(f.root, 'missing-source.git') })
  assert.notEqual(result.status, 0) // Stop locally before any real network access.
  assert.match(result.stdout, /\[1\/4\] Fetch GitHub main/)
  for (const args of [['remote', 'get-url', 'origin'], ['remote', 'get-url', '--push', 'origin']]) {
    assert.equal(git(f.worker, args), targetUrl)
  }
  assert.doesNotMatch(readFileSync(join(f.worker, '.git/config'), 'utf8'), /test-only-/)
  assert.doesNotMatch(result.stdout + result.stderr, /test-only-/)
  assert.equal(f.head(), f.baseline)
})

test('missing deployment configuration fails before fetching', t => {
  const f = fixture(t)
  for (const key of ['SYNC_SOURCE_URL', 'SYNC_COMMIT_NAME', 'SYNC_COMMIT_EMAIL',
    'SYNC_TARGET_URL', 'SYNC_GITLAB_USERNAME']) {
    const result = f.run({ SYNC_GITLAB_TOKEN: 'test-only-token', [key]: '' })
    assert.notEqual(result.status, 0, key)
    assert.match(result.stderr, new RegExp(`${key} is required`))
    assert.doesNotMatch(result.stdout, /Fetch/)
  }
  assert.equal(f.head(), f.baseline)
})

test('credential-bearing or malformed target URLs are rejected without logging their value', t => {
  const f = fixture(t)
  for (const url of [
    'http://gitlab.example.test/example/project.git',
    'https://user:test-only-token@gitlab.example.test/example/project.git',
    `${targetUrl}?token=test-only-token`, `${targetUrl}#fragment`,
    `${targetUrl}\nextra=value`, 'https://gitlab.example.test',
  ]) {
    const result = f.run({ SYNC_GITLAB_TOKEN: 'test-only-token', SYNC_TARGET_URL: url })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SYNC_TARGET_URL must be an HTTPS repository URL/)
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-token|Fetch/)
  }
  assert.equal(f.head(), f.baseline)
})

test('initial sync requires an explicitly configured baseline pair', t => {
  const f = fixture(t)
  for (const key of ['SYNC_BOOTSTRAP_TARGET', 'SYNC_BOOTSTRAP_SOURCE']) {
    const result = f.run({ [key]: '' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Initial sync requires/)
  }
  assert.equal(f.head(), f.baseline)
})
