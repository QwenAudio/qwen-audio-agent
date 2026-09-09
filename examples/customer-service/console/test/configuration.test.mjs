import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  configurationDiff,
  formatJson,
  frontendConfigName,
  validateConfiguration,
  validateFlowsDocument,
  validateGuardsDocument,
} from '../configuration.mjs'
import { applyConfiguration, loadConfiguration, previewConfiguration } from '../server.mjs'
import { formatFlowPrompt, loadFlowsFrom } from '../../agent/flows.mjs'

const clone = value => JSON.parse(JSON.stringify(value))

test('两个域当前的完整配置都能通过应用前校验', () => {
  for (const domain of ['retail', 'airline']) {
    const configuration = loadConfiguration(domain)
    const result = validateConfiguration(domain, configuration)
    assert.equal(result.ok, true, `${domain}: ${JSON.stringify(result.errors)}`)
  }
})

test('航空工具面写入航空文件，不能再覆盖零售文件', () => {
  assert.equal(frontendConfigName('retail'), 'frontend-mcp.json')
  assert.equal(frontendConfigName('airline'), 'frontend-mcp.airline.json')
})

test('跨域工具不能进入前台白名单', () => {
  const configuration = loadConfiguration('airline')
  configuration.frontendMcp.servers['customer-service'].tools.return_items = {
    enabled: true,
    description: '这是零售工具，航空域不该接受',
  }
  const result = validateConfiguration('airline', configuration)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.path.includes('return_items')))
})

test('决策表没有兜底行时预览失败，不会留到通话中才炸', () => {
  const configuration = loadConfiguration('retail')
  const broken = clone(configuration.guards)
  broken.decisions.refund_authority.rules = [
    { when: { amount: '> 2000' }, then: 'escalate' },
  ]
  const result = validateGuardsDocument('retail', broken)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /catch-all/)
})

test('流程规则拒绝重复 id 和空步骤', () => {
  const result = validateFlowsDocument('retail', {
    version: 1,
    domain: 'retail',
    rules: [
      { id: 'same', before: '', after: '办理' },
      { id: 'same', before: '核验', after: '办理' },
    ],
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => /before/.test(error.path)))
  assert.ok(result.errors.some(error => /重复 id/.test(error.message)))
})

test('配置 diff 给出可审计的字段路径', () => {
  const before = loadConfiguration('airline')
  const after = clone(before)
  after.guards.decisions.change_fee.rules[1].then = 250
  after.flows.rules[0].after = '办理改签'
  const diff = configurationDiff(before, after)
  assert.ok(diff.guards.some(change => change.path === 'decisions.change_fee.rules'))
  assert.ok(diff.flows.some(change => change.path === 'rules'))
})

test('未修改的完整配置预览为零变化', () => {
  const configuration = loadConfiguration('retail')
  const result = previewConfiguration('retail', configuration)
  assert.equal(result.ok, true)
  assert.equal(result.changeCount, 0)
})

test('应用配置会原子写入 guards 与 flows，并留下备份和审计', t => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-service-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = name => pathToFileURL(join(dir, name))
  const targets = {
    guards: target('guards.json'),
    flows: target('flows.json'),
    review: target('review.json'),
    frontendMcp: target('frontend-mcp.json'),
  }
  const current = loadConfiguration('retail')
  for (const [name, url] of Object.entries(targets)) {
    writeFileSync(url, JSON.stringify(current[name]))
  }
  const proposed = clone(current)
  proposed.guards.decisions.refund_authority.rules[0].when.amount = '> 2500'
  proposed.flows.rules[0].after = '办理新的业务'
  const result = applyConfiguration('retail', proposed, {
    current,
    targets,
    runtime: pathToFileURL(`${join(dir, 'runtime')}/`),
    db: JSON.parse(readFileSync(new URL('../../domains/retail/db.json', import.meta.url))),
  })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.deepEqual(result.written, [
    'domains/retail/guards.json',
    'domains/retail/flows.json',
  ])
  assert.equal(JSON.parse(readFileSync(targets.guards)).decisions
    .refund_authority.rules[0].when.amount, '> 2500')
  assert.equal(JSON.parse(readFileSync(targets.flows)).rules[0].after, '办理新的业务')
  assert.ok(result.backup)
  assert.match(readFileSync(target('runtime/audit.jsonl'), 'utf8'), /refund_authority/)
})

// 【这条是为一个会静默损坏配置的 bug 立的】formatJson 早期版本先判预算再分支，
// 于是一条超预算的长字符串走进了对象展开分支，被 Object.entries 拆成
// {"0":"由","1":" ",…}。retail 的 _note 有 131 字符，正好越线。
// 现象是「应用成功」但文件里那条说明变成了一坨字符表 —— 没有测试根本发现不了。
test('长字符串不会被序列化器拆成字符对象', () => {
  // 【长度必须真的超过行内预算】第一版这里只有 72 字符，于是整个对象都留在一行，
  // 压根没走到出 bug 的展开分支 —— 把兜底删掉它照样绿。反证时才发现这条是假的。
  const long = '这是一条长到必须超过行内预算的说明文字，'.repeat(8)
  assert.ok(long.length > 100, '用例本身要越过预算，否则测不到那个分支')
  const value = { _note: long, version: 1 }
  const written = formatJson(value)
  assert.deepEqual(JSON.parse(written), value)
  assert.equal(typeof JSON.parse(written)._note, 'string')
})

test('序列化器让短结构留在一行，长结构才展开', () => {
  assert.equal(formatJson({ when: { status: 'shipped' }, then: 'refuse' }).trim(),
    '{ "when": { "status": "shipped" }, "then": "refuse" }')
  assert.match(formatJson({ rules: Array.from({ length: 8 },
    (unused, index) => ({ when: { amount: `> ${index}00` }, then: 'escalate' })) }), /\n/)
})

// 写回不能把手写的紧凑排版炸开。实测过：用 JSON.stringify(value, null, 2) 时，
// 改一个值让 airline/guards.json 产生 328 行改动 —— 那等于把「配置可审」这条删掉。
test('写回真实 guards.json 不丢语义，也不让 diff 爆炸', () => {
  for (const domain of ['retail', 'airline']) {
    const path = new URL(`../../domains/${domain}/guards.json`, import.meta.url)
    const original = readFileSync(path, 'utf8')
    const parsed = JSON.parse(original)
    const written = formatJson(parsed)
    assert.deepEqual(JSON.parse(written), parsed, `${domain} 写回后语义变了`)
    const grew = written.split('\n').length - original.split('\n').length
    assert.ok(grew <= 4, `${domain} 写回后行数多了 ${grew} 行，排版被炸开了`)
  }
})

// 【这条测的是用户真正要的那件事】管理员在配置台裁决一条顺序候选、点应用，
// 后台 Agent 的 prompt 里就该多出这条约束 —— 不需要任何人去手改文件。
// 之前的测试只证明了「配置文件能驱动 executor」，那是另一回事：
// 文件是我手写进去的，没有一条测试走过「界面上的裁决 → 落盘 → Agent」这条链。
test('裁决一条顺序候选并应用后，后台 Agent 的 prompt 里就多出这条约束', t => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-service-loop-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = name => pathToFileURL(join(dir, name))
  const targets = {
    guards: target('guards.json'),
    flows: target('flows.json'),
    review: target('review.json'),
    frontendMcp: target('frontend-mcp.json'),
  }
  const current = loadConfiguration('airline')
  for (const [name, url] of Object.entries(targets)) {
    writeFileSync(url, formatJson(current[name]))
  }
  const before = formatFlowPrompt(loadFlowsFrom(join(dir, 'flows.json'), 'airline'))
  assert.doesNotMatch(before, /确认候选航班有余位/)

  // 配置台上的动作：把一条顺序候选标成「接受」，同时落成一条流程规则。
  const key = 'order:先确认候选航班有余位 → 再出票'
  const proposed = clone(current)
  proposed.review.items[key] = {
    status: 'accepted',
    item: { kind: 'order', before: '确认候选航班有余位', after: '出票' },
    updatedAt: new Date().toISOString(),
  }
  proposed.flows.rules.push({
    id: 'review-seat-first',
    enabled: true,
    before: '确认候选航班有余位',
    after: '出票',
    sourceKey: key,
  })

  const preview = previewConfiguration('airline', proposed, { current, db: null })
  assert.equal(preview.ok, true, JSON.stringify(preview.errors))
  assert.equal(preview.effect.flows, '后台 Agent 的下一个任务立即生效')

  const applied = applyConfiguration('airline', proposed, {
    current,
    targets,
    runtime: pathToFileURL(`${join(dir, 'runtime')}/`),
    db: null,
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))

  // 落盘之后重新读 —— 这一步不许走内存里的草稿，必须真的从文件来。
  const after = formatFlowPrompt(loadFlowsFrom(join(dir, 'flows.json'), 'airline'))
  assert.match(after, /先「确认候选航班有余位」，再「出票」/)
  assert.equal(JSON.parse(readFileSync(targets.review)).items[key].status, 'accepted')
})

// 反面：撤销裁决之后，那条约束要从 prompt 里消失。
// 只测「加得上」不够 —— 加得上但撤不掉的话，管理员改错一次就没法回头了。
test('撤销裁决并应用后，这条约束从 Agent prompt 里消失', t => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-service-undo-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = name => pathToFileURL(join(dir, name))
  const targets = {
    guards: target('guards.json'),
    flows: target('flows.json'),
    review: target('review.json'),
    frontendMcp: target('frontend-mcp.json'),
  }
  const key = 'order:先确认候选航班有余位 → 再出票'
  const seeded = clone(loadConfiguration('airline'))
  seeded.review.items[key] = { status: 'accepted', item: { kind: 'order' }, updatedAt: null }
  seeded.flows.rules.push({
    id: 'review-seat-first', enabled: true,
    before: '确认候选航班有余位', after: '出票', sourceKey: key,
  })
  for (const [name, url] of Object.entries(targets)) {
    writeFileSync(url, formatJson(seeded[name]))
  }
  assert.match(formatFlowPrompt(loadFlowsFrom(join(dir, 'flows.json'), 'airline')), /确认候选航班有余位/)

  const undone = clone(seeded)
  delete undone.review.items[key]
  undone.flows.rules = undone.flows.rules.filter(rule => rule.sourceKey !== key)
  const applied = applyConfiguration('airline', undone, {
    current: seeded,
    targets,
    runtime: pathToFileURL(`${join(dir, 'runtime')}/`),
    db: null,
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.doesNotMatch(formatFlowPrompt(loadFlowsFrom(join(dir, 'flows.json'), 'airline')),
    /确认候选航班有余位/)
})
