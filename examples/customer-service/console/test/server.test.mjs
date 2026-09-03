import assert from 'node:assert/strict'
import test from 'node:test'
import { createConsoleServer } from '../server.mjs'

// 配置台的路由测试。【刻意不覆盖抽取】那条路径要调模型，
// 一次一分钟，不适合放进单测 —— 它的逻辑已经在 consensus.test.mjs
// 用固定数据覆盖过了。这里测的是「界面拿到的数据形状对不对」，
// 因为浏览器实测抓到的两个 bug 都是字段名对不上，而不是逻辑错。

async function withServer(probe) {
  const server = createConsoleServer()
  await new Promise(resolve => server.listen(0, resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await probe(base)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const get = async (base, path) => {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json() }
}

test('首页返回 HTML', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    const html = await response.text()
    assert.match(html, /Policy 配置台/)
  })
})

test('域列表两个都在', async () => {
  await withServer(async base => {
    const { body } = await get(base, '/api/domains')
    assert.deepEqual(body.domains.map(item => item.id), ['retail', 'airline'])
  })
})

test('policy 原文按行返回，行号从 1 开始', async () => {
  await withServer(async base => {
    const { body } = await get(base, '/api/policy?domain=retail')
    assert.ok(body.lines.length > 50)
    assert.equal(body.lines[0].line, 1)
    // 界面靠 line 字段做跳转，行号必须连续
    assert.equal(body.lines[17].line, 18)
  })
})

test('未知域不返回文件内容', async () => {
  await withServer(async base => {
    const { body } = await get(base, '/api/policy?domain=../../../etc/passwd')
    assert.ok(body.error, '未知域必须被拒绝')
    assert.equal(body.lines, undefined)
  })
})

test('决策表摊平后带兜底行标记', async () => {
  await withServer(async base => {
    const { body } = await get(base, '/api/guards?domain=airline')
    assert.equal(body.tables.length, 7)
    const baggage = body.tables.find(table => table.name === 'free_baggage_allowance')
    assert.deepEqual(baggage.inputs, ['memberTier', 'cabin'])
    assert.equal(baggage.rules.length, 10)
    // 【兜底行必须能被界面识别】它决定「未覆盖的输入怎么办」，
    // 是这张表里最该被人确认的一行。
    const catchAll = baggage.rules.filter(rule => rule.isCatchAll)
    assert.equal(catchAll.length, 1)
    assert.equal(catchAll[0].index, 10, '兜底行应是最后一行')
  })
})

test('注释键不会被当成决策表送到界面', async () => {
  await withServer(async base => {
    const { body } = await get(base, '/api/guards?domain=airline')
    for (const table of body.tables) {
      assert.ok(!table.name.startsWith('_'), `${table.name} 是注释键`)
    }
  })
})

test('前置条件带 policy 行号，界面才能跳转', async () => {
  await withServer(async base => {
    const { body } = await get(base, '/api/guards?domain=retail')
    assert.ok(body.preconditions.length >= 5)
    for (const rule of body.preconditions) {
      assert.equal(typeof rule.policyLine, 'number', `${rule.tool} 缺行号`)
      assert.ok(rule.requires.length)
    }
  })
})

test('工具面建议带 suggested 与 ifOverridden 两个字段', async () => {
  await withServer(async base => {
    const { body } = await get(base, '/api/surfaces')
    assert.equal(body.suggestions.length, 9)
    for (const tool of body.suggestions) {
      // 【这两个字段名是浏览器实测抓过的坑】
      // UI 里凭记忆写成 surface / message，结果界面上一片 undefined。
      assert.ok(['frontend', 'backend'].includes(tool.suggested), `${tool.name} 缺 suggested`)
      assert.equal(typeof tool.why, 'string')
      assert.equal(typeof tool.ifOverridden, 'string', `${tool.name} 缺 ifOverridden`)
    }
  })
})

test('把写库工具挪到前台会给出 risk 级警告', async () => {
  await withServer(async base => {
    const overrides = encodeURIComponent(JSON.stringify({ cancel_order: 'frontend' }))
    const { body } = await get(base, `/api/surfaces?overrides=${overrides}`)
    assert.equal(body.warnings.length, 1)
    const warning = body.warnings[0]
    assert.equal(warning.name, 'cancel_order')
    assert.equal(warning.severity, 'risk')
    // 界面读的是 detail，不是 message
    assert.equal(typeof warning.detail, 'string')
    assert.match(warning.detail, /auth_required|批准|确认/)
  })
})

test('把只读工具挪到后台只是 slowdown，不是 risk', async () => {
  await withServer(async base => {
    const overrides = encodeURIComponent(JSON.stringify({ identity_status: 'backend' }))
    const { body } = await get(base, `/api/surfaces?overrides=${overrides}`)
    assert.equal(body.warnings[0].severity, 'slowdown')
    assert.match(body.warnings[0].detail, /延迟|静默|拖慢/)
  })
})

test('掩盖会反映到导出的白名单里', async () => {
  await withServer(async base => {
    const plain = (await get(base, '/api/surfaces')).body
    const overrides = encodeURIComponent(JSON.stringify({ cancel_order: 'frontend' }))
    const moved = (await get(base, `/api/surfaces?overrides=${overrides}`)).body
    // frontend-mcp.json 的结构是 servers['customer-service'].tools，
    // 白名单不在顶层 —— 这个形状由上游的 gateway 决定，不是我们能选的。
    const listOf = mcp => Object.keys(mcp.servers['customer-service'].tools)
    assert.ok(!listOf(plain.frontendMcp).includes('cancel_order'))
    assert.ok(listOf(moved.frontendMcp).includes('cancel_order'),
      '挪到前台后必须出现在白名单里，否则开关是假的')
  })
})

test('导出的白名单结构与 gateway 期望的一致', async () => {
  await withServer(async base => {
    const { body } = await get(base, '/api/surfaces')
    const mcp = body.frontendMcp
    assert.equal(mcp.version, 1)
    const server = mcp.servers['customer-service']
    assert.equal(server.enabled, true)
    // url 留成占位符，由 .env 注入 —— 导出的配置不该把本机端口写死
    assert.match(server.url, /\$\{[A-Z_]+\}/)
    for (const [name, entry] of Object.entries(server.tools)) {
      assert.equal(entry.enabled, true, `${name} 没启用`)
      assert.ok(entry.description, `${name} 缺描述`)
    }
  })
})

test('坏掉的 overrides 参数不会让服务崩', async () => {
  await withServer(async base => {
    const { status, body } = await get(base, '/api/surfaces?overrides=not-json')
    assert.equal(status, 200)
    assert.equal(body.suggestions.length, 9)
  })
})

test('未知路由返回 404', async () => {
  await withServer(async base => {
    const { status } = await get(base, '/api/nope')
    assert.equal(status, 404)
  })
})

test('导出拒绝未知域，不写任何文件', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'nope', guards: { hacked: true } }),
    })
    assert.equal(response.status, 400)
  })
})
