#!/usr/bin/env node
// Materialize the bilingual docs tree for VitePress.
//
// The repository keeps bilingual pairs side by side (`page.md` + `page.zh.md`),
// while VitePress i18n expects a directory mirror (`zh/page.md`). This script
// generates `docs/.vitepress/.site/`:
//   <path>/page.md        — English source, copied as-is
//   zh/<path>/page.md     — Chinese source, renamed, with relative links to
//                           `*.zh.md` companions rewritten to `*.md`
// Assets (non-markdown files) are copied into both trees.
//
// Run once for builds (`npm run docs:build` does this via predocs:build), or
// with `--watch` during `npm run docs:dev` to resync on changes.

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const docsDir = join(rootDir, 'docs')
const siteDir = join(docsDir, '.vitepress', '.site')

const EXCLUDED_DIRS = new Set(['promo', 'roadmap', 'node_modules'])
// Roadmap/presentation pages are maintainer-facing, not user-manual content:
// they stay in the repo but never land on the site.
const EXCLUDED_FILES = new Set([
  'i18n-parity.md',
  'frontend-agent-roadmap.md',
  'voice-agent-architecture-presentation.zh.md',
])

function walk(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || EXCLUDED_DIRS.has(name)) continue
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...walk(full, rel))
    else out.push(rel)
  }
  return out
}

// In the generated zh tree the companion lives at `page.md`, so relative
// markdown links to `page.zh.md` are rewritten. Absolute URLs stay untouched.
function rewriteZhLinks(content) {
  return content.replace(/(\]\()([^)\s]+?)\.zh\.md(?=[)#])/g, (match, open, target) =>
    /^[a-z][a-z0-9+.-]*:/i.test(target) ? match : `${open}${target}.md`)
}

function write(dest, writeContent) {
  mkdirSync(dirname(dest), { recursive: true })
  writeContent(dest)
}

function sync() {
  // VitePress may be reading the tree while we replace it; retry briefly
  // instead of crashing the watcher on ENOTEMPTY/ENOENT races.
  rmSync(siteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  const files = walk(docsDir).filter((rel) => !EXCLUDED_FILES.has(rel))
  const published = new Set(files)
  const missingPairs = []
  for (const rel of published) {
    if (!rel.endsWith('.md')) continue
    const companion = rel.endsWith('.zh.md')
      ? rel.replace(/\.zh\.md$/, '.md')
      : rel.replace(/\.md$/, '.zh.md')
    if (!published.has(companion)) missingPairs.push(`${rel} -> ${companion}`)
  }
  if (missingPairs.length) {
    throw new Error(`Published documentation must be bilingual:\n${missingPairs.join('\n')}`)
  }
  for (const rel of files) {
    const src = join(docsDir, rel)
    if (rel.endsWith('.zh.md')) {
      const dest = join(siteDir, 'zh', rel.replace(/\.zh\.md$/, '.md'))
      write(dest, () => writeFileSync(dest, rewriteZhLinks(readFileSync(src, 'utf8'))))
    } else if (rel.endsWith('.md')) {
      write(join(siteDir, rel), (dest) => copyFileSync(src, dest))
    } else {
      // Asset: mirror into the zh tree so relative references keep working.
      write(join(siteDir, rel), (dest) => copyFileSync(src, dest))
      write(join(siteDir, 'zh', rel), (dest) => copyFileSync(src, dest))
    }
  }
  console.log(`[docs-site] materialized ${files.length} files -> ${relative(rootDir, siteDir)}`)
}

sync()

if (process.argv.includes('--watch')) {
  let timer
  watch(docsDir, { recursive: true }, (_event, filename) => {
    if (!filename || filename.startsWith('.vitepress')) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        sync()
      } catch (error) {
        // Keep the watcher alive: a transient mid-edit state (e.g. a new
        // page saved before its companion) should not kill docs:dev.
        console.error(`[docs-site] sync failed: ${error.message}`)
      }
    }, 200)
  })
  console.log('[docs-site] watching docs/ for changes')
}
