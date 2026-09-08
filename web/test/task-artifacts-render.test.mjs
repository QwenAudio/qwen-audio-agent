import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Children, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let server
let TaskArtifacts

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  })
  TaskArtifacts = (await server.ssrLoadModule('/src/TaskArtifacts.jsx')).default
})

after(async () => { await server?.close() })

function artifacts(part) {
  return [{ artifactId: 'preview', name: 'Preview', parts: [part] }]
}

function render(part) {
  return renderToStaticMarkup(createElement(TaskArtifacts, {
    artifacts: artifacts(part),
  }))
}

test('renders inline images and downloadable files in the shared client', () => {
  const image = render({
    url: 'data:image/png;base64,aGVsbG8=',
    mediaType: 'image/png',
    filename: 'preview.png',
  })
  assert.match(image, /<img[^>]+src="data:image\/png;base64,aGVsbG8="/)
  assert.match(image, /download="preview.png"/)
  assert.doesNotMatch(image, /media-consent/)

  const file = render({
    url: 'data:text/plain,hello%20world',
    mediaType: 'text/plain',
    filename: 'result.txt',
  })
  assert.match(file, /href="data:text\/plain,hello%20world"/)
  assert.match(file, /download="result.txt"/)
  assert.doesNotMatch(file, /<img/)
})

test('requires explicit loading for each remote media type', () => {
  for (const mediaType of ['image/png', 'audio/mpeg', 'video/mp4']) {
    const html = render({ url: 'https://example.test/preview', mediaType })
    assert.match(html, /media-consent/)
    assert.match(html, /<button/)
    assert.doesNotMatch(html, /<(?:img|audio|video)\b/)
  }
})

// Inspect the real component tree without mounting the hook-owning MediaEmbed.
// Its React key must change to discard approval when an artifact replaces its URL.
function findMedia(element) {
  if (element?.type?.name === 'MediaEmbed') return element
  if (typeof element?.type === 'function') {
    return findMedia(element.type(element.props))
  }
  return Children.toArray(element?.props?.children).map(findMedia).find(Boolean)
}

test('replaces remote media consent when an incremental artifact changes its source', () => {
  const view = url => findMedia(createElement(TaskArtifacts, {
    artifacts: artifacts({ url, mediaType: 'image/png' }),
  }))
  const first = view('https://example.test/first.png')
  const unchanged = view('https://example.test/first.png')
  const replaced = view('https://example.test/second.png')
  assert.ok(first)
  assert.ok(replaced)
  assert.equal(first.key, unchanged.key)
  assert.notEqual(first.key, replaced.key)
})
