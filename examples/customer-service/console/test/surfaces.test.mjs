import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFrontendMcp,
  overrideWarnings,
  suggestSurfaces,
} from '../surfaces.mjs'
import { FRONTEND_TOOL_NAMES, toolDefinitions } from '../../service/tools/registry.mjs'

function fakeTool(name, { annotations = {}, required = [], properties = {} } = {}) {
  return {
    name,
    title: name,
    description: name,
    inputSchema: { type: 'object', properties, required },
    annotations,
  }
}

test('两段式工具建议后台，理由指向 auth_required', () => {
  const [item] = suggestSurfaces([
    fakeTool('cancel_order', {
      annotations: { destructiveHint: true, monetaryHint: true },
      properties: { orderId: {}, reason: {}, approval_token: {} },
      required: ['orderId', 'reason'],
    }),
  ])
  assert.equal(item.suggested, 'backend')
  assert.equal(item.ruleId, 'needs_approval')
  assert.match(item.why, /auth_required/)
  assert.equal(item.facts.twoPhase, true)
})

test('只读工具建议前台，理由指向延迟', () => {
  const [item] = suggestSurfaces([
    fakeTool('get_order', { annotations: { readOnlyHint: true }, required: ['orderId'] }),
  ])
  assert.equal(item.suggested, 'frontend')
  assert.equal(item.ruleId, 'read_only')
  assert.match(item.why, /延迟|往返/)
})

test('判据顺序：涉款优先于单步写，不能被顺序错乱放到前台', () => {
  // 【顺序敏感】一个涉款但只有一个必填参数的工具，若先判 single_step_write
  // 就会被放到前台。RULES 的排列顺序保证 monetary 先命中。
  const [item] = suggestSurfaces([
    fakeTool('process_refund', {
      annotations: { monetaryHint: true },
      required: ['orderId'],
    }),
  ])
  assert.equal(item.suggested, 'backend')
  assert.equal(item.ruleId, 'monetary')
})

test('性质不明的工具兜底走后台', () => {
  // 参数多且没有任何标注 —— manifest 说不清它是什么。
  // 放后台只是慢，放前台可能绕过尚未识别的保护。
  const [item] = suggestSurfaces([
    fakeTool('mystery_tool', { required: ['a', 'b', 'c', 'd'] }),
  ])
  assert.equal(item.suggested, 'backend')
  assert.equal(item.ruleId, 'unknown')
})

test('自动建议与手写的前台白名单一致', () => {
  // 【交叉验证】surfaces.mjs 不读 FRONTEND_TOOL_NAMES，它只看 manifest 的
  // annotations 与 schema。两条独立路径得出同一份名单，说明手写白名单
  // 与工具自身声明的性质没有矛盾。
  // 这条如果变红，要么是新工具的标注漏了，要么是白名单被手改跑偏了。
  const auto = suggestSurfaces()
    .filter(item => item.suggested === 'frontend')
    .map(item => item.name)
    .sort()
  assert.deepEqual(auto, [...FRONTEND_TOOL_NAMES].sort())
})

test('生成的 frontend-mcp.json 只含建议前台的工具', () => {
  const config = buildFrontendMcp(suggestSurfaces())
  const names = Object.keys(config.servers['customer-service'].tools)
  assert.deepEqual(names.sort(), [...FRONTEND_TOOL_NAMES].sort())
  assert.equal(config.version, 1)
  // url 保留成占位符，由 .env.local 注入 —— 配置文件里不写死端口
  assert.match(config.servers['customer-service'].url, /^\$\{/)
})

test('overrides 能把工具挪到前台，并生成到配置里', () => {
  const suggestions = suggestSurfaces()
  const config = buildFrontendMcp(suggestions, { overrides: { cancel_order: 'frontend' } })
  assert.ok(Object.keys(config.servers['customer-service'].tools).includes('cancel_order'))
})

test('把后台工具挪到前台标为 risk，反方向只是 slowdown', () => {
  const suggestions = suggestSurfaces()
  const risky = overrideWarnings(suggestions, { cancel_order: 'frontend' })
  assert.equal(risky.length, 1)
  assert.equal(risky[0].severity, 'risk')
  assert.match(risky[0].detail, /auth_required/)

  const slow = overrideWarnings(suggestions, { get_order: 'backend' })
  assert.equal(slow.length, 1)
  assert.equal(slow[0].severity, 'slowdown')
})

test('没有推翻时不产生警告', () => {
  const suggestions = suggestSurfaces()
  assert.equal(overrideWarnings(suggestions).length, 0)
  // 显式写成和建议一样的值也不算推翻
  assert.equal(overrideWarnings(suggestions, { get_order: 'frontend' }).length, 0)
})

test('每条建议都带得出理由与推翻后果', () => {
  for (const item of suggestSurfaces()) {
    assert.ok(item.why, `${item.name} 缺理由`)
    assert.ok(item.ifOverridden, `${item.name} 缺推翻后果`)
  }
})

test('后台面的每个工具都能拿到建议', () => {
  const suggestions = suggestSurfaces()
  assert.equal(suggestions.length, toolDefinitions('backend').length)
})
