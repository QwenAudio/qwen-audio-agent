import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  BACKEND_TOOL_DEFINITIONS,
  FRONTEND_TOOL_DEFINITIONS,
} from '../service/tools/registry.mjs'

test('assigns weather to the foreground and all other cockpit tools to the backend', () => {
  assert.deepEqual(FRONTEND_TOOL_DEFINITIONS.map(tool => tool.name), ['weather'])
  assert.equal(BACKEND_TOOL_DEFINITIONS.length, 14)
  assert.ok(!BACKEND_TOOL_DEFINITIONS.some(tool => tool.name === 'weather'))
})

test('binds the cockpit frontend profile to the scoped MCP configuration', () => {
  const profileUrl = new URL('../frontend-profile.json', import.meta.url)
  const profile = JSON.parse(readFileSync(
    profileUrl,
    'utf8',
  ))
  const config = JSON.parse(readFileSync(
    new URL(profile.toolSources.mcp, profileUrl),
    'utf8',
  ))
  assert.equal(profile.toolSources.mcp, 'service/tools/frontend-mcp.json')
  assert.equal(config.servers.cockpit.url, '${COCKPIT_FRONTEND_MCP_URL}')
  assert.deepEqual(Object.keys(config.servers.cockpit.tools), ['weather'])
})

test('keeps asynchronous cockpit acknowledgements natural and action-specific', () => {
  const assistant = readFileSync(
    new URL('../ASSISTANT.md', import.meta.url),
    'utf8',
  )
  assert.match(assistant, /不说“好的，已为你提交”/u)
  assert.match(assistant, /不提“提交”“已受理”“后台”“任务”/u)
  assert.match(assistant, /优先简短复述关键对象和动作/u)
  assert.match(assistant, /可以省略主语/u)
  assert.match(assistant, /不要固定使用某种开头、句式或话术/u)
  assert.doesNotMatch(assistant, /导航时说|点歌时说|闪购时说|车控时说/u)
  assert.match(assistant, /必须忠实保留用户当前的动作和已选商品/u)
  assert.match(assistant, /不得改写成再次搜索/u)
  assert.match(assistant, /不得只口头承诺处理/u)
})
