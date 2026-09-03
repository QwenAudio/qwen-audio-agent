import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { startCustomerServiceGateway } from '../server.mjs'

// 网关装配的测试。它不起真实语音会话 —— 那要 API key 和三个进程。
// 这里只断言【装配出来的能力面是对的】，因为出问题的恰恰是这一层：
// 工具多了一个不该有的，功能上一切正常，只是模型会走错路。

async function withGateway(probe) {
  const runtime = startCustomerServiceGateway({ port: 0 })
  await new Promise(resolve => runtime.server.once('listening', resolve))
  const { port } = runtime.server.address()
  try {
    await probe(`http://127.0.0.1:${port}`, runtime)
  } finally {
    await runtime.close()
  }
}

test('前台不暴露联网检索能力', async () => {
  // 【这条是实测踩出来的】客户问退货政策，模型调了 web_search，
  // 拿回来的是昆明本地宝、法律咨询、书法拍卖（「明远」被搜成「明星大侦探」），
  // 然后建议客户自己去查细则 —— 而细则就在 domains/retail/policy.md 里。
  //
  // 客服的信息边界是封闭的：能说的话只该来自 policy 和数据库。
  await withGateway(async (base) => {
    const response = await fetch(`${base}/api/health`)
    const health = await response.json()
    const retrieval = health.frontendRetrieval || {}
    const capabilities = retrieval.capabilities || []
    assert.ok(
      !capabilities.includes('web-search'),
      `前台不该有 web-search，实际能力：${capabilities.join(', ')}`,
    )
    assert.ok(
      !capabilities.includes('url-fetch'),
      `前台不该有 url-fetch，实际能力：${capabilities.join(', ')}`,
    )
    assert.equal(retrieval.searchProvider, null, '不该装配任何搜索 provider')
  })
})

test('前台白名单只有五个只读或单步工具', async () => {
  const mcp = JSON.parse(readFileSync(
    new URL('../frontend-mcp.json', import.meta.url), 'utf8',
  ))
  const tools = Object.keys(mcp.servers['customer-service'].tools)
  assert.deepEqual(tools.sort(), [
    'check_variant', 'get_order', 'identity_status', 'list_orders', 'verify_identity',
  ])
  // 写库类工具一个都不能在前台 —— 它们要走 auth_required 等客户批准
  for (const forbidden of ['cancel_order', 'return_items', 'modify_address']) {
    assert.ok(!tools.includes(forbidden), `${forbidden} 不该在前台白名单里`)
  }
})

test('每个前台工具的描述都写了选用规则', async () => {
  // manifest 里的 title 太短（「订单列表」），撑不起「模型什么时候该调它」。
  // 描述是模型选工具的唯一依据，所以这里要求它足够长。
  const mcp = JSON.parse(readFileSync(
    new URL('../frontend-mcp.json', import.meta.url), 'utf8',
  ))
  for (const [name, tool] of Object.entries(mcp.servers['customer-service'].tools)) {
    assert.equal(tool.enabled, true, `${name} 没启用`)
    assert.ok(
      String(tool.description).length >= 40,
      `${name} 的描述只有 ${tool.description.length} 字，写不清什么时候该调它`,
    )
  }
})

test('spawn_thinking 描述里写了「提交后不要承诺结果」', async () => {
  const { CUSTOMER_SERVICE_SPAWN_THINKING_DESCRIPTION } = await import('../spawn-thinking-tool.mjs')
  // 涉及金额的操作会挂起等客户批准。模型若在提交后就说「已经办好了」，
  // 客户随后又被问一次要不要办，两句话对不上。
  assert.match(CUSTOMER_SERVICE_SPAWN_THINKING_DESCRIPTION, /不要向客户承诺结果|不要说「已经帮您办好了」/)
  assert.match(CUSTOMER_SERVICE_SPAWN_THINKING_DESCRIPTION, /取消订单|退货/)
})

test('前台 MCP 地址由环境变量注入，不写死端口', async () => {
  const raw = readFileSync(new URL('../frontend-mcp.json', import.meta.url), 'utf8')
  const mcp = JSON.parse(raw)
  const url = mcp.servers['customer-service'].url
  assert.match(url, /^\$\{[A-Z_]+\}$/, `url 应是占位符，实际是 ${url}`)
  assert.ok(!raw.includes('127.0.0.1'), '配置文件里不该出现本机地址')
})
