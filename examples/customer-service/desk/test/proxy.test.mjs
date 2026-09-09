import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createDeskServer } from '../server.mjs'

// 坐席台的测试。它不起真实会话 —— 只验「代理和页面装配是对的」，
// 因为这一层出问题的方式是静默的：页面打开一片空白，控制台没报错。

async function withServer(probe) {
  const server = createDeskServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await probe(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const page = () => readFileSync(new URL('../index.html', import.meta.url), 'utf8')

test('根路径返回坐席台页面', async () => {
  await withServer(async (base) => {
    const response = await fetch(base)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.match(await response.text(), /人工坐席台/)
  })
})

test('页面明说它不回复客户', () => {
  // 【这句必须在页面上】不写的话演示时容易被当成「人工能回话了」，
  // 而回复要接回语音通道 —— 那需要「人接管语音通道」的机制，是另一件事。
  assert.match(page(), /不回复客户/)
})

test('未核验就转过来时页面警告坐席重新核验', () => {
  // 「身份核验两种方式都不通过」那类转接就是这个样子 ——
  // 坐席不能凭客户自己报的订单号办业务。
  const html = page()
  assert.match(html, /客户未核验/)
  assert.match(html, /重新核验/)
})

test('页面显示转接原因与审计，那是转接要交出去的东西', () => {
  // 转人工是四个出口里唯一没有可见结果的：退货看得到订单状态变、
  // 退票看得到余额回来，而转接在客服界面上只留一句「已转接」。
  // 这一页要证明上下文真的交出去了 —— 所以这三样都得在。
  const html = page()
  assert.match(html, /转接原因/)
  assert.match(html, /转接时间/)
  assert.match(html, /AI 客服已经做了什么/)
})

test('service 路径走代理，其余 404', async () => {
  // 【上游地址要自己指定，不能靠「本机恰好没起 service」】
  // 原来这条测试依赖默认上游 3110 上没人监听。真跑着 demo 的时候它就红了 ——
  // 代理转发成功拿到 200，而断言写的是 502。测试挂在一个环境条件上，
  // 而那个条件恰好在「开发者正在用这个 demo」时不成立，最没用的时候最先坏。
  //
  // 指到 127.0.0.1:1：绑它需要 root，实际上永远不会有人在听，于是必定连不上。
  // 这和 client/test/proxy.test.mjs 里那条 502 用例是同一个做法。
  const saved = process.env.CS_SERVICE_ORIGIN
  process.env.CS_SERVICE_ORIGIN = 'http://127.0.0.1:1'
  try {
    await withServer(async (base) => {
      // 【为什么要代理】浏览器直连 service 会被 DNS rebinding 防护拦下
      // （origin host 必须等于请求 host，跨端口永远过不了）——
      // client/server.mjs 那边踩过这个坑。
      //
      // 上游连不上，所以代理会 502。502 说明它【试图】转发了，
      // 那正是要验的；404 才说明路由没配。
      const proxied = await fetch(`${base}/api/service/state?sessionId=t`)
      assert.equal(proxied.status, 502, '应该尝试转发到 service')
      assert.equal((await fetch(`${base}/nope`)).status, 404)
    })
  } finally {
    if (saved === undefined) delete process.env.CS_SERVICE_ORIGIN
    else process.env.CS_SERVICE_ORIGIN = saved
  }
})

test('代理不转发 Origin', () => {
  // 转发了就等于把跨源问题原样带给 service。
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(source, /'origin'/)
  assert.match(source, /不转发 Origin|不转发 host/)
})

test('SSE 逐块转发，不等 body 读完', () => {
  // 状态推送是长连接，等它结束就永远等不到第一帧。
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(source, /getReader\(\)/)
  assert.match(source, /逐块转发/)
})

test('接手只改本地标记，不写回 service', () => {
  // 【坐席「看到了」不是业务状态】写回去的话，换客户之后会残留
  // 一个假的接手记录，而那个记录对不上任何一通实际通话。
  const html = page()
  assert.match(html, /不写回 service/)
})
