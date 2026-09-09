import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Children, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let server
let PermissionActions
let setRuntimeLanguage

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  })
  PermissionActions = (await server.ssrLoadModule('/src/PermissionActions.jsx')).default
  ;({ setRuntimeLanguage } = await server.ssrLoadModule('/src/i18n.js'))
})

after(async () => { await server?.close() })

function markup(authorization = {}) {
  return renderToStaticMarkup(createElement(PermissionActions, {
    authorization, onRespond() {},
  }))
}

test('permission buttons are short in both languages and retain session scope in accessible hints', () => {
  for (const [lang, labels, scope] of [
    ['zh', ['允许此任务', '始终允许', '拒绝'], '本会话后续权限请求自动允许'],
    ['en', ['Allow task', 'Always allow', 'Deny'], 'Automatically allow later permission requests in this session'],
  ]) {
    setRuntimeLanguage(lang)
    const html = markup()
    assert.deepEqual([...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(match => match[1]), labels)
    assert.ok(html.includes(`title="${scope}"`))
    assert.ok(html.includes(`aria-label="${labels[1]}：${scope}"`))
    assert.match(html, /role="group"/)
  }
})

test('each button sends its own decision and pending submission keeps all labels stable', () => {
  setRuntimeLanguage('en')
  const calls = []
  const element = PermissionActions({ authorization: {}, onRespond: decision => calls.push(decision) })
  const group = Children.toArray(element.props.children)[0]
  for (const button of Children.toArray(group.props.children)) button.props.onClick()
  assert.deepEqual(calls, ['task', 'always', 'reject'])
  const html = markup({ submitting: true, error: 'Could not send; try again.' })
  assert.equal([...html.matchAll(/disabled=""/g)].length, 3)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /role="status">Submitting/)
  assert.match(html, /role="alert">Could not send; try again\./)
  assert.match(html, />Always allow<\/button>/)
})
