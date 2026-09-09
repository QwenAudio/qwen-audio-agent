// Policy 配置台的服务端。
//
// 【它只产出配置，不参与执行】
// 配置台把 policy.md 抽成 guards.json / frontend-mcp.json，管理员改完导出，
// executor 下次执行时读到新配置。它不在通话的关键路径上 ——
// 配置台挂了，通话照常，只是改不了配置。
//
// 这一点决定了它可以是个简单的单进程 HTTP 服务：不需要高可用，
// 不需要和 service 共享状态。

import { createServer } from 'node:http'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { pathToFileURL } from 'node:url'
import { extractPolicy, partition } from './extract.mjs'
import { consense } from './consensus.mjs'
import { checkCoverage } from './coverage.mjs'
import { validateDatabase } from './db-validate.mjs'
import { buildFrontendMcp, overrideWarnings, suggestSurfaces } from './surfaces.mjs'
import {
  configurationDiff,
  formatJson,
  frontendConfigName,
  validateConfiguration,
} from './configuration.mjs'
import { loadGuards } from '../service/guards.mjs'
import { toolDefinitions } from '../service/tools/registry.mjs'
import { loadServiceEnvironment } from '../bootstrap/environment.mjs'

const DOMAINS = Object.freeze(['retail', 'airline'])
const DOMAIN_LABELS = Object.freeze({ retail: '零售客服', airline: '航空客服' })
const CACHE_DIR = new URL('./.cache/', import.meta.url)
const DEFAULT_RUNS = 3

function domainUrl(domain, file) {
  if (!DOMAINS.includes(domain)) return null
  return new URL(`../domains/${domain}/${file}`, import.meta.url)
}

const CONSOLE_RUNTIME = new URL('../.runtime-console/', import.meta.url)

function frontendMcpUrl(domain) {
  return new URL(`../gateway/${frontendConfigName(domain)}`, import.meta.url)
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback)
    throw error
  }
}

function emptyFlows(domain) {
  return { version: 1, domain, rules: [] }
}

function emptyReview(domain) {
  return { version: 1, domain, updatedAt: null, items: {} }
}

// 返回【磁盘上的 canonical 形状】，不是 /api/guards 为展示摊平后的 tables[]。
// 编辑器如果把 tables[] 直接写回，service 会找不到 decisions —— 这是两种 schema，
// 必须在边界上明确区分。
export function loadConfiguration(domain, { targets = configurationTargets(domain) } = {}) {
  if (!DOMAINS.includes(domain)) throw new Error(`unknown domain: ${domain}`)
  return {
    guards: readJson(targets.guards, {}),
    flows: readJson(targets.flows, emptyFlows(domain)),
    review: readJson(targets.review, emptyReview(domain)),
    frontendMcp: readJson(targets.frontendMcp, {}),
  }
}

function frontendNames(frontendMcp) {
  return new Set(Object.keys(frontendMcp?.servers?.['customer-service']?.tools || {}))
}

function overridesFromFrontend(domain, frontendMcp) {
  const enabled = frontendNames(frontendMcp)
  const suggestions = suggestSurfaces(toolDefinitions('backend', domain))
  const overrides = {}
  for (const tool of suggestions) {
    const current = enabled.has(tool.name) ? 'frontend' : 'backend'
    if (current !== tool.suggested) overrides[tool.name] = current
  }
  return { suggestions, overrides }
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

function text(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    // 【必须禁缓存】页面每次都从磁盘读，但浏览器会缓存它。
    // 实测代价：改完 index.html 后刷新拿到的还是旧页面，
    // 于是「修好的 bug 看起来没修好」，白排查了两轮。
    // 这是个开发期工具，少一次网络往返换不来什么。
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

// 抽取一次要跑 3 遍模型，约一分钟。缓存到文件，这样刷新页面不用重抽 ——
// 管理员在界面上来回切换域是常态。
function cachePath(domain, runs) {
  return new URL(`./${domain}-${runs}.json`, CACHE_DIR)
}

function readCache(domain, runs) {
  const path = cachePath(domain, runs)
  if (!existsSync(path)) return null
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8'))
    // policy 改了缓存就失效 —— 否则管理员改完 policy 看到的还是旧结论。
    const current = readFileSync(domainUrl(domain, 'policy.md'), 'utf8')
    if (cached.policyLength !== current.length) return null
    return cached
  } catch {
    return null
  }
}

function writeCache(domain, runs, payload) {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath(domain, runs), JSON.stringify(payload, null, 2))
}

async function runExtraction(domain, runs, onProgress) {
  const policyPath = domainUrl(domain, 'policy.md')
  // 【抽取时把数据库交给模型】
  // 否则抽取是盲的：它不知道库里有什么，所以发现不了两类缺口 ——
  // 「库里有 furniture 但细则没提这个类别」、
  // 「有订单第 8 天签收而退货窗口是 7 天，超期样本存在但细则没说怎么处理」。
  // 这两类以前靠 coverage.mjs 事后检，而那是另一份列表，管理员得自己对应。
  const db = JSON.parse(readFileSync(domainUrl(domain, 'db.json'), 'utf8'))
  const results = []
  for (let index = 0; index < runs; index += 1) {
    onProgress?.({ done: index, total: runs })
    const extracted = await extractPolicy(policyPath, { db })
    results.push(partition(extracted))
  }
  onProgress?.({ done: runs, total: runs })
  const consensus = consense(results)
  return {
    domain,
    runs,
    policyLength: readFileSync(policyPath, 'utf8').length,
    extractedAt: new Date().toISOString(),
    ...consensus,
  }
}

// 把 guards.json 里的决策表摊成界面能直接渲染的行。
// 【下划线开头的键是注释，要跳过】它们不是决策表。
function flattenGuards(domain) {
  const guards = loadGuards(domain)
  const tables = Object.entries(guards.decisions).map(([name, table]) => ({
    name,
    hitPolicy: table.hitPolicy || 'first',
    inputs: table.inputs || [],
    policyLine: table.policyLine ?? null,
    rules: (table.rules || []).map((rule, index) => ({
      index: index + 1,
      when: rule.when || {},
      then: rule.then,
      reason: rule.reason || null,
      // 兜底行在界面上要能一眼看出来 —— 它决定「未覆盖的输入怎么办」，
      // 是这张表里最该被人确认的一行。
      isCatchAll: !Object.keys(rule.when || {}).length
        || Object.values(rule.when || {}).every(value => {
          const cleaned = String(value ?? '').trim()
          return !cleaned || cleaned === '-' || cleaned === '*'
        }),
    })),
  }))
  const preconditions = Object.entries(guards.preconditions).map(([tool, rule]) => ({
    tool,
    requires: rule.requires || [],
    onMissing: rule.onMissing || 'refuse',
    message: rule.message || '',
    policyLine: rule.policyLine ?? null,
  }))
  return {
    version: guards.version,
    tables,
    preconditions,
    enums: guards.enums,
    thresholds: guards.thresholds,
  }
}

const routes = {
  'GET /api/domains': () => ({
    domains: DOMAINS.map(id => ({ id, label: DOMAIN_LABELS[id] })),
  }),

  // policy 原文带行号返回。抽取项里的 line 字段指向这里 ——
  // 界面上点一条规则要能跳到它的依据，否则「行号校验」这个机制看不见。
  'GET /api/policy': (url) => {
    const domain = url.searchParams.get('domain')
    const path = domainUrl(domain, 'policy.md')
    if (!path) return { error: 'unknown domain' }
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    return { domain, lines: lines.map((content, index) => ({ line: index + 1, content })) }
  },

  'GET /api/guards': (url) => {
    const domain = url.searchParams.get('domain')
    if (!DOMAINS.includes(domain)) return { error: 'unknown domain' }
    return { domain, ...flattenGuards(domain) }
  },

  // 覆盖度检查：新传的 policy 抽出来的规则，现有数据能不能演示得出来。
  // 它回答的是「改了配置但看不出效果」那类问题 ——
  // 比如 policy 提到家具类 30 天可退，而库里根本没有家具商品。
  'GET /api/coverage': (url) => {
    const domain = url.searchParams.get('domain')
    if (!DOMAINS.includes(domain)) return { error: 'unknown domain' }
    const guards = loadGuards(domain)
    const db = JSON.parse(readFileSync(domainUrl(domain, 'db.json'), 'utf8'))
    return { domain, ...checkCoverage(guards, db) }
  },

  // 当前的数据库原文。给编辑器预填。
  'GET /api/database': (url) => {
    const domain = url.searchParams.get('domain')
    if (!DOMAINS.includes(domain)) return { error: 'unknown domain' }
    return { domain, text: readFileSync(domainUrl(domain, 'db.json'), 'utf8') }
  },

  'GET /api/surfaces': (url) => {
    const domain = url.searchParams.get('domain') || 'retail'
    if (!DOMAINS.includes(domain)) return { error: 'unknown domain' }
    const currentMcp = readJson(frontendMcpUrl(domain), {})
    const current = overridesFromFrontend(domain, currentMcp)
    const overridesRaw = url.searchParams.get('overrides')
    let overrides = current.overrides
    try {
      if (overridesRaw) overrides = JSON.parse(overridesRaw)
    } catch {
      overrides = current.overrides
    }
    const suggestions = suggestSurfaces(toolDefinitions('backend', domain))
    const frontendMcp = buildFrontendMcp(suggestions, { overrides })
    if (currentMcp._note) frontendMcp._note = currentMcp._note
    // 没挪动的工具保留已有的完整调用说明。manifest 的 description 更短，
    // 如果每碰一次开关就把详细说明降级，模型何时调用工具会悄悄变差。
    const currentTools = currentMcp.servers?.['customer-service']?.tools || {}
    const nextTools = frontendMcp.servers['customer-service'].tools
    for (const [name, config] of Object.entries(nextTools)) {
      if (currentTools[name]?.description) config.description = currentTools[name].description
    }
    return {
      domain,
      suggestions,
      overrides,
      // 管理员把某个工具挪到前台会有什么后果 —— 这条必须显示出来，
      // 否则他只是在切一个开关，看不到代价。
      warnings: overrideWarnings(suggestions, overrides),
      frontendMcp,
    }
  },

  'GET /api/configuration': (url) => {
    const domain = url.searchParams.get('domain')
    if (!DOMAINS.includes(domain)) return { error: 'unknown domain' }
    return { domain, configuration: loadConfiguration(domain) }
  },

  'GET /api/extract': (url) => {
    const domain = url.searchParams.get('domain')
    const runs = Number(url.searchParams.get('runs')) || DEFAULT_RUNS
    if (!DOMAINS.includes(domain)) return { error: 'unknown domain' }
    const cached = readCache(domain, runs)
    return cached ? { cached: true, ...cached } : { cached: false, pending: true }
  },
}

// 抽取走 SSE：三次模型调用要一分钟，界面上得看到「第几次跑完了」，
// 否则用户不知道是在跑还是卡住了。
async function handleExtractStream(request, response, url) {
  const domain = url.searchParams.get('domain')
  const runs = Math.min(Math.max(Number(url.searchParams.get('runs')) || DEFAULT_RUNS, 1), 5)
  if (!DOMAINS.includes(domain)) {
    json(response, 400, { error: 'unknown domain' })
    return
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const send = (event, data) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const force = url.searchParams.get('force') === '1'
  if (!force) {
    const cached = readCache(domain, runs)
    if (cached) {
      send('done', { cached: true, ...cached })
      response.end()
      return
    }
  }

  try {
    const payload = await runExtraction(domain, runs, progress => send('progress', progress))
    writeCache(domain, runs, payload)
    send('done', { cached: false, ...payload })
  } catch (error) {
    // 抽取失败最常见的原因是没配 API key。把原始消息带出去 ——
    // 界面上显示「抽取失败」而不说为什么，用户无从下手。
    send('failed', { message: error.message })
  }
  response.end()
}

export function configurationTargets(domain) {
  return {
    guards: domainUrl(domain, 'guards.json'),
    flows: domainUrl(domain, 'flows.json'),
    review: domainUrl(domain, 'review.json'),
    frontendMcp: frontendMcpUrl(domain),
  }
}

function serialize(value) {
  return formatJson(value)
}

function atomicWrite(target, content) {
  const filename = target.pathname.split('/').pop()
  const temporary = new URL(`./.${filename}.${process.pid}.${Date.now()}.tmp`, target)
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, target)
}

// 预览是【应用的同一条校验路径】，不是浏览器自己猜一次。
// 否则最糟的情况是预览说能写，真正写盘时用另一套规则才拒绝。
export function previewConfiguration(domain, proposed, options = {}) {
  if (!DOMAINS.includes(domain)) {
    return { ok: false, errors: [{ path: 'domain', message: `未知的域：${domain}` }] }
  }
  const verdict = validateConfiguration(domain, proposed)
  if (!verdict.ok) return verdict
  const current = options.current || loadConfiguration(domain, options)
  const diff = configurationDiff(current, proposed)
  const changed = Object.entries(diff)
    .filter(([, changes]) => changes.length)
    .map(([name, changes]) => ({ name, changes }))
  const { suggestions, overrides } = overridesFromFrontend(domain, proposed.frontendMcp)
  const warnings = overrideWarnings(suggestions, overrides)
  const db = options.db || JSON.parse(readFileSync(domainUrl(domain, 'db.json'), 'utf8'))
  const coverage = checkCoverage(proposed.guards, db)
  return {
    ok: true,
    changed,
    coverage,
    changeCount: changed.reduce((total, entry) => total + entry.changes.length, 0),
    warnings,
    requiresRestart: diff.frontendMcp.length ? ['gateway'] : [],
    effect: {
      guards: diff.guards.length ? '下一次工具调用立即生效' : '未修改',
      flows: diff.flows.length ? '后台 Agent 的下一个任务立即生效' : '未修改',
      frontendMcp: diff.frontendMcp.length ? '重启对应域 gateway 后生效' : '未修改',
    },
  }
}

export function applyConfiguration(domain, proposed, options = {}) {
  const { acknowledgeRisks = false } = options
  const preview = previewConfiguration(domain, proposed, options)
  if (!preview.ok) return preview
  if (preview.warnings.some(item => item.severity === 'risk') && !acknowledgeRisks) {
    return {
      ...preview,
      ok: false,
      needsRiskAcknowledgement: true,
      errors: [{ path: 'frontendMcp', message: '包含绕过批准链的高风险工具面改动，必须明确确认' }],
    }
  }
  if (!preview.changed.length) return { ...preview, ok: true, written: [], note: '配置没有变化' }

  const targets = options.targets || configurationTargets(domain)
  const runtime = options.runtime || CONSOLE_RUNTIME
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = new URL(`./backups/${stamp}-${domain}/`, runtime)
  mkdirSync(backupDir, { recursive: true })
  const originals = new Map()
  const written = []
  try {
    for (const { name } of preview.changed) {
      const target = targets[name]
      const old = existsSync(target) ? readFileSync(target, 'utf8') : null
      originals.set(name, old)
      if (old !== null) writeFileSync(new URL(`./${name}.json`, backupDir), old, 'utf8')
      atomicWrite(target, serialize(proposed[name]))
      written.push(name === 'frontendMcp'
        ? `gateway/${frontendConfigName(domain)}`
        : `domains/${domain}/${name === 'review' ? 'review.json' : `${name}.json`}`)
    }
  } catch (error) {
    // 多文件提交中途失败就恢复已经写过的文件，避免 guards 与 flows 半新半旧。
    for (const name of [...originals.keys()].reverse()) {
      const old = originals.get(name)
      if (old !== null) atomicWrite(targets[name], old)
    }
    return { ok: false, errors: [{ path: 'write', message: error.message }] }
  }

  mkdirSync(runtime, { recursive: true })
  appendFileSync(new URL('./audit.jsonl', runtime), `${JSON.stringify({
    at: new Date().toISOString(),
    domain,
    written,
    changedPaths: Object.fromEntries(preview.changed.map(entry => [
      entry.name, entry.changes.map(change => change.path),
    ])),
  })}\n`, 'utf8')
  return {
    ...preview,
    ok: true,
    written,
    backup: `.runtime-console/backups/${stamp}-${domain}`,
    note: preview.requiresRestart.length
      ? '业务规则与流程已生效；工具面变化需重启对应域 gateway。'
      : '已应用；下一次工具调用或后台任务立即使用新配置。',
  }
}

function handleConfigurationRequest(response, body, apply) {
  const { domain, configuration, acknowledgeRisks } = body || {}
  const result = apply
    ? applyConfiguration(domain, configuration, { acknowledgeRisks })
    : previewConfiguration(domain, configuration)
  const status = result.ok ? 200 : result.needsRiskAcknowledgement ? 409 : 422
  json(response, status, result)
}

// 兼容旧入口。旧界面只传 frontendMcp；合并进完整配置后仍走同一套校验与写盘。
function handleExport(response, body) {
  if (!DOMAINS.includes(body?.domain)) {
    json(response, 400, { error: 'unknown domain' })
    return
  }
  const configuration = { ...loadConfiguration(body.domain), ...body }
  delete configuration.domain
  handleConfigurationRequest(response, {
    domain: body.domain,
    configuration,
    acknowledgeRisks: true,
  }, true)
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 512 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// 解析 + 校验，不写盘。两个端点共用 ——
// 写盘那个必须先过这一道，否则校验就只是个建议。
function validateOnly({ domain, text } = {}) {
  if (!DOMAINS.includes(domain)) return { ok: false, errors: [{ path: '', message: `未知的域：${domain}` }] }
  let parsed
  try {
    parsed = JSON.parse(text || '')
  } catch (error) {
    // JSON 语法错要单独报 —— 它和引用断链是两回事，
    // 混在一起会让人以为是数据关系出了问题。
    return { ok: false, errors: [{ path: '', message: `JSON 解析失败：${error.message}` }] }
  }
  return { domain, ...validateDatabase(domain, parsed) }
}

// 【写盘之前必须先备份】
// 管理员把库改坏了又想退回去时，没有备份就只能 git checkout ——
// 而那会把他在配置台里做的其余改动一并丢掉。
function handleDatabaseWrite(response, body) {
  const verdict = validateOnly(body)
  if (!verdict.ok) {
    // 422 而不是 400：请求本身是合法的，是内容过不了业务校验。
    json(response, 422, verdict)
    return
  }
  const target = domainUrl(body.domain, 'db.json')
  const backup = new URL(`db.backup.json`, target)
  writeFileSync(backup, readFileSync(target, 'utf8'), 'utf8')
  // 四个空格缩排，和仓里其余 JSON 一致 —— 否则每改一次 diff 全是格式噪声。
  writeFileSync(target, `${JSON.stringify(JSON.parse(body.text), null, 2)}\n`, 'utf8')
  json(response, 200, {
    ok: true,
    domain: body.domain,
    // 【这一句必须说】已经跑着的 service 进程把 db.json 缓在内存里（loadDomain 只读一次），
    // 不重启就看不到新数据。不说的话管理员会以为写失败了。
    note: '已写入。跑着的 service 进程要重启才会读到新数据（会话里的库是启动时装载的）。',
    backup: 'db.backup.json',
  })
}

export function createConsoleServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    const key = `${request.method} ${url.pathname}`

    try {
      if (key === 'GET /' || key === 'GET /index.html') {
        const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
        text(response, 200, html, 'text/html; charset=utf-8')
        return
      }
      if (key === 'GET /api/extract/stream') {
        await handleExtractStream(request, response, url)
        return
      }
      if (key === 'POST /api/configuration/preview') {
        handleConfigurationRequest(response, await readBody(request), false)
        return
      }
      if (key === 'POST /api/configuration/apply') {
        handleConfigurationRequest(response, await readBody(request), true)
        return
      }
      if (key === 'POST /api/export') {
        handleExport(response, await readBody(request))
        return
      }
      // 只校不写。编辑器里每改完一次就调这个，
      // 管理员在点「应用」之前就能看到断了哪一条。
      if (key === 'POST /api/database/validate') {
        const body = await readBody(request)
        json(response, 200, validateOnly(body))
        return
      }
      if (key === 'POST /api/database') {
        const body = await readBody(request)
        handleDatabaseWrite(response, body)
        return
      }
      const handler = routes[key]
      if (handler) {
        json(response, 200, handler(url))
        return
      }
      json(response, 404, { error: 'not found' })
    } catch (error) {
      json(response, 500, { error: error.message })
    }
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  loadServiceEnvironment()
  const port = Number(process.env.CONSOLE_PORT || 4610)
  createConsoleServer().listen(port, () => {
    console.log(`Policy 配置台  http://127.0.0.1:${port}`)
  })
}
