// 一条命令起一组客服进程。
//
//   node bootstrap/start.mjs retail     零售  service 3110 / agent 3120 / gateway 18889 / client 4620
//   node bootstrap/start.mjs airline    航空  端口各 +100，两组可以同时跑
//
// 【为什么要能同时跑，而不是切换】
// CS_DOMAIN 在网关启动时决定三样东西：用哪份人设、policy 检索源装哪个域、
// state-store 的默认域。前两个烘进进程，改了要重启。
//
// 换域重启是能用的，但管理员在配置台里选系统之后还要去命令行重启，
// 那个断点很难在演示里解释清楚。两组进程各占一套端口同时跑，
// 「选系统」就退化成「打开哪个链接」—— 没有隐藏状态。
//
// 代价是八个进程。座舱那边一条命令起四个，我们起八个，形态一致。

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadServiceEnvironment } from './environment.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

// 端口偏移：航空 +100。留够间隔，将来加第三个域也不会撞。
const DOMAIN_OFFSET = Object.freeze({ retail: 0, airline: 100 })

const BASE = Object.freeze({
  service: 3110,
  agent: 3120,
  gateway: 18_889,
  client: 4620,
})

// 【每个进程要哪些环境变量】写全而不是靠继承 ——
// 靠继承的话，同时跑两组时后起的那组会读到前一组的 CS_SERVICE_ORIGIN。
function environmentFor(domain) {
  const offset = DOMAIN_OFFSET[domain]
  if (offset === undefined) {
    throw new Error(`未知的域：${domain}（可选 ${Object.keys(DOMAIN_OFFSET).join(' / ')}）`)
  }
  const port = Object.fromEntries(
    Object.entries(BASE).map(([key, value]) => [key, value + offset]),
  )
  return {
    CS_DOMAIN: domain,
    CS_SERVICE_PORT: String(port.service),
    CS_SERVICE_ORIGIN: `http://127.0.0.1:${port.service}`,
    CS_AGENT_PORT: String(port.agent),
    CS_AGENT_CARD_URL: `http://127.0.0.1:${port.agent}/.well-known/agent-card.json`,
    CS_GATEWAY_PORT: String(port.gateway),
    CS_GATEWAY_ORIGIN: `http://127.0.0.1:${port.gateway}`,
    CS_CLIENT_PORT: String(port.client),
    // 【运行时目录也要分开】两组共用 .runtime 会让对话历史串在一起 ——
    // 网关按 sessionId 分目录，而两组用的都是 default。
    QWAUDIO_CONFIG_DIR: `${ROOT}.runtime-${domain}`,
    QWAUDIO_DATA_DIR: `${ROOT}.runtime-${domain}`,
    port,
  }
}

const PROCESSES = Object.freeze([
  { name: 'service', cwd: 'service', args: ['server.mjs'], color: '\u001B[33m' },
  { name: 'agent', cwd: 'agent', args: ['server.mjs'], color: '\u001B[36m' },
  { name: 'gateway', cwd: '.', args: ['gateway/server.mjs'], color: '\u001B[32m' },
  { name: 'client', cwd: 'client', args: ['server.mjs'], color: '\u001B[35m' },
])

const RESET = '\u001B[0m'

export function startDomain(domain, { onSpawn } = {}) {
  const env = environmentFor(domain)
  const { port } = env
  delete env.port

  const children = []
  for (const spec of PROCESSES) {
    const child = spawn(process.execPath, spec.args, {
      cwd: new URL(`../${spec.cwd}/`, import.meta.url),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tag = `${spec.color}[${domain}/${spec.name}]${RESET}`
    // 前缀每一行，否则八个进程的输出混在一起没法看。
    const prefix = stream => {
      let buffer = ''
      stream.on('data', chunk => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) if (line.trim()) console.log(`${tag} ${line}`)
      })
    }
    prefix(child.stdout)
    prefix(child.stderr)
    child.on('exit', code => {
      // 【一个挂了要说出来】静默退出会让人以为服务还在，
      // 然后花时间排查「为什么工具调不动」。
      if (code !== 0) console.log(`${tag} 退出，code=${code}`)
    })
    children.push({ ...spec, child })
    onSpawn?.(spec.name, child)
  }

  return {
    domain,
    port,
    children,
    async close() {
      for (const { child } of children) {
        if (!child.killed) child.kill('SIGTERM')
      }
    },
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  loadServiceEnvironment()
  const domains = process.argv.slice(2).filter(Boolean)
  const wanted = domains.length ? domains : ['retail']

  const running = wanted.map(domain => startDomain(domain))

  console.log()
  for (const group of running) {
    console.log(`${group.domain}：`)
    console.log(`  客服工作台（用户）   http://127.0.0.1:${group.port.client}`)
    console.log(`  语音网关自带界面     http://127.0.0.1:${group.port.gateway}`)
    console.log(`  service              http://127.0.0.1:${group.port.service}`)
  }
  console.log()
  console.log('Policy 配置台（管理员，域无关）  cd console && npm start')
  console.log()

  const stop = async () => {
    for (const group of running) await group.close()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
