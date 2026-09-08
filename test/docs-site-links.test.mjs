import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkDocsSite } from '../scripts/check-docs-site.mjs'

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-docs-links-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  return root
}

test('docs check accepts bilingual clean URLs, encoded anchors, assets, and external links', t => {
  const root = fixture(t, {
    'index.html': '<h1 id="home">Home</h1><a href="/manual/zh/guide#%E5%BC%80%E5%A7%8B">中文</a><a href="https://example.com/no-page">external</a><a href="mailto:a@example.com">mail</a><a href="./asset.svg">asset</a>',
    'zh/guide.html': '<h2 id="开始">开始</h2><a href="../#home">home</a><a href="#开始">local</a>',
    'asset.svg': '<svg/>',
  })
  assert.deepEqual(checkDocsSite(root, '/manual/'), { pages: 2, errors: [] })
})

test('docs check rejects stale anchors, missing pages, and incorrect deployment bases', t => {
  const root = fixture(t, {
    'index.html': '<a href="/manual/guide#old">old section</a><a href="/manual/missing">missing</a><a href="/guide">wrong base</a>',
    'guide.html': '<h1 id="new">New</h1>',
  })
  const { errors } = checkDocsSite(root, '/manual/')
  assert.equal(errors.length, 3)
  assert.ok(errors.some(error => error.includes('missing anchor')))
  assert.ok(errors.some(error => error.includes('missing target')))
  assert.ok(errors.some(error => error.includes('escapes site base')))
})

test('docs check supports root hosting and directory index pages', t => {
  const root = fixture(t, {
    'index.html': '<a href="/guide/#intro">guide</a>',
    'guide/index.html': '<h2 id="intro">Intro</h2>',
  })
  assert.deepEqual(checkDocsSite(root, '/'), { pages: 2, errors: [] })
})
