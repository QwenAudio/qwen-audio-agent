import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function htmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return htmlFiles(path)
    return entry.name.endsWith('.html') ? [path] : []
  })
}

// Inspect trusted VitePress output, including generated navigation. The regular
// build catches missing Markdown pages; this also checks section fragments.
export function checkDocsSite(directory, base = '/qwen-audio-agent/') {
  const root = resolve(directory)
  const origin = 'https://manual.invalid'
  const prefix = `/${base.split('/').filter(Boolean).join('/')}/`.replace('//', '/')
  const errors = new Set()
  const ids = new Map()
  const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  const pages = htmlFiles(root)
  for (const path of pages) {
    const html = readFileSync(path, 'utf8')
    const pageUrl = new URL(prefix + relative(root, path).split('\\').join('/'), origin)
    for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']*)["']/gi)) {
      const href = decode(match[1])
      const url = new URL(href, pageUrl)
      if (url.origin !== origin) continue
      if (!url.pathname.startsWith(prefix)) {
        errors.add(`${relative(root, path)}: link escapes site base: ${href}`)
        continue
      }
      const pathname = decodeURIComponent(url.pathname.slice(prefix.length))
      const candidates = [join(root, pathname), join(root, `${pathname}.html`), join(root, pathname, 'index.html')]
      const target = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile())
      if (!target) {
        errors.add(`${relative(root, path)}: missing target: ${href}`)
        continue
      }
      if (!url.hash || !target.endsWith('.html')) continue
      if (!ids.has(target)) {
        ids.set(target, new Set([...readFileSync(target, 'utf8').matchAll(/\bid=["']([^"']+)["']/gi)]
          .map(item => decode(item[1]))))
      }
      if (!ids.get(target).has(decodeURIComponent(url.hash.slice(1)))) {
        errors.add(`${relative(root, path)}: missing anchor: ${href}`)
      }
    }
  }
  return { pages: pages.length, errors: [...errors] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const result = checkDocsSite(join(root, 'docs/.vitepress/dist'), process.env.DOCS_BASE)
  if (result.errors.length) {
    console.error(result.errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`[docs-site] checked links and anchors in ${result.pages} pages`)
  }
}
