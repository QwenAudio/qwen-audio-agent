import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadBenchmarkCases } from '../evaluator/cases.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = path => readFileSync(resolve(root, path), 'utf8')
const guide = read('bench/README.md')
const results = read('bench/results/accuracy.md')
const short = loadBenchmarkCases({ suite: 'short' })
const long = loadBenchmarkCases({ suite: 'long' })

function tableRows(markdown) {
  return markdown.split('\n').filter(line => line.startsWith('|'))
    .map(line => line.slice(1, line.lastIndexOf('|')).split('|').map(cell => cell.trim()))
    .filter(row => !row.every(cell => /^:?-+:?$/u.test(cell)))
}

function section(markdown, heading) {
  // Git checkouts can use CRLF on Windows; section boundaries are logical lines.
  markdown = markdown.replace(/\r\n?/gu, '\n')
  const marker = `${heading}\n`
  const start = markdown.indexOf(marker)
  assert.ok(start >= 0, `missing section: ${heading}`)
  const body = markdown.slice(start + marker.length)
  const level = /^#+/u.exec(heading)[0].length
  const next = new RegExp(`^#{1,${level}} `, 'mu').exec(body)
  return next ? body.slice(0, next.index) : body
}

test('Markdown sections accept platform line endings without consuming adjacent sections', () => {
  const lines = ['# Results', '', '## Short cases — full-case pass', '',
    '| Subject | Rate |', '|---|---:|', '| Example | 97.67% |', '',
    '### Details', 'Counts stay in this section.', '', '## 长对话', 'Next section.']
  const expected = lines.slice(3, 11).join('\n') + '\n'
  for (const ending of ['\n', '\r\n', '\r']) {
    const markdown = lines.join(ending)
    assert.equal(section(markdown, '## Short cases — full-case pass'), expected)
    assert.equal(section(markdown, '## 长对话'), 'Next section.')
  }
})

function suiteCounts(cases) {
  const perTurn = cases.flatMap(c => c.turns.map((_, i) => (
    c.expected_calls.filter(call => call.turn_index === i)
  )))
  assert.ok(perTurn.every(calls => calls.length <= 1), 'update the one-call-per-turn documentation')
  return {
    cases: cases.length,
    turns: perTurn.length,
    required: perTurn.filter(calls => calls.length).length,
    noTool: perTurn.filter(calls => !calls.length).length,
    calls: cases.reduce((n, c) => n + c.expected_calls.length, 0),
    tools: new Set(cases.flatMap(c => c.expected_calls.map(call => call.name))).size,
  }
}

test('benchmark suite table matches case, turn, expected-call and tool-coverage counts', () => {
  for (const [name, cases] of [['Short', short], ['Long', long]]) {
    const actual = tableRows(guide).find(row => row[0] === name)
    const counts = suiteCounts(cases)
    const lengths = cases.map(c => c.turns.length)
    const min = Math.min(...lengths), max = Math.max(...lengths)
    assert.deepEqual(actual, [name, String(counts.cases), min === max ? String(min) : `${min}–${max}`,
      ...['turns', 'required', 'noTool', 'calls', 'tools'].map(key => String(counts[key]))])
  }
  const shortNames = new Set(short.flatMap(c => c.expected_calls.map(call => call.name)))
  assert.ok(long.flatMap(c => c.expected_calls).every(call => shortNames.has(call.name)))
  for (const [domain, file] of [['Vehicle', 'vehicle'], ['Music', 'music'], ['Navigation', 'navigation'], ['Weather', 'weather']]) {
    const cases = short.filter(c => c.domain === file)
    assert.deepEqual(tableRows(guide).find(row => row[0] === domain),
      [domain, `[${file}.jsonl](cases/${file}.jsonl)`, String(cases.length),
        String(cases.reduce((n, c) => n + c.expected_calls.length, 0))])
  }
})

test('example READMEs agree on suite units and point to one accuracy-results page', () => {
  for (const file of ['README.md', 'README_ZH.md']) {
    const text = read(file)
    assert.ok(text.includes('(bench/results/accuracy.md)'))
    const rows = tableRows(text)
    for (const [names, cases] of [[['Short', '短用例'], short], [['Long dialogue', '长对话'], long]]) {
      const row = rows.find(row => names.includes(row[0]))
      const c = suiteCounts(cases)
      assert.equal(row[1], String(c.cases))
      assert.equal(Number.parseInt(row[2], 10), c.turns)
      assert.equal(row[3], String(c.required))
      assert.equal(row[4], String(c.tools))
    }
    assert.doesNotMatch(text, /88\.80%|71\.60%/u, 'historical numbers belong in the archive')
  }
})

test('bilingual headline tables match canonical scores, run subgroups and return timings', () => {
  const shortTable = tableRows(section(results, '## Short cases — full-case pass'))
  const overall = shortTable.find(row => row[0] === 'Overall')
  const expectedShort = shortTable[0].slice(2).map((subject, index) => [subject, overall[index + 2]])
  const expectedLong = tableRows(section(results, '## Long dialogue — per-turn tool behavior')).slice(1)
  const timing = read('bench/results/voice-surface-short-20260911.json.md')
  const all = tableRows(section(timing, '## After execution')).find(row => row[0] === 'all')

  for (const config of [
    {
      file: 'README.md',
      shortHeading: '### Short cases: full-case pass rate',
      shortLabels: ['Subject', 'Full-case pass rate'],
      longHeading: '### Long dialogue: per-turn tool behavior',
      longLabels: ['Subject', 'Overall turn accuracy', 'Tool-required turn pass', 'No-tool turn correctness'],
      timingHeading: '### Tool-return latency: foreground vs. backend placement',
      timingLabels: ['Tool placement', 'Mean tool-return latency (s)', 'Valid timing samples'],
      routes: ['Foreground direct', 'Backend delegated'],
      sourceNote: /team-provided per-turn counts/iu,
      traceNote: /lack\s+published raw traces/u,
      timingNote: /include failed returns/u,
    },
    {
      file: 'README_ZH.md',
      shortHeading: '### 短用例：整例通过率',
      shortLabels: ['评测对象', '整例通过率'],
      longHeading: '### 长对话：逐轮工具行为准确率',
      longLabels: ['评测对象', '总体逐轮准确率', '需工具轮通过率', '无工具轮正确率'],
      timingHeading: '### 工具返回时延：前台直调与后台委托',
      timingLabels: ['工具执行方式', '平均工具返回时延（秒）', '有效计时样本数'],
      routes: ['前台直调', '后台委托'],
      sourceNote: /团队于 9 月 14 日提供的逐轮统计/u,
      traceNote: /尚未公开原始轨迹与完整配置/u,
      timingNote: /保留失败返回/u,
    },
  ]) {
    const text = read(config.file)
    assert.deepEqual(tableRows(section(text, config.shortHeading)), [config.shortLabels, ...expectedShort], config.file)
    assert.deepEqual(tableRows(section(text, config.longHeading)), [config.longLabels, ...expectedLong], config.file)
    assert.deepEqual(tableRows(section(text, config.timingHeading)), [config.timingLabels,
      [config.routes[0], all[2], all[5]], [config.routes[1], all[3], all[6]]], config.file)
    assert.match(text, config.sourceNote)
    assert.match(text, config.traceNote)
    assert.match(text, config.timingNote)
    assert.ok(text.includes('(bench/results/accuracy-history.md)'))
    assert.doesNotMatch(section(text, config.longHeading), /9\/10|88\.80%|71\.60%|75\.20%/u,
      'case/sequence diagnostic scores must not replace the same-turn metric')
  }
})

test('long-suite repetition and fixed-position caveats describe the actual dataset', () => {
  const rows = long.flatMap(c => c.turns.map((turn, i) => ({
    user: turn.user,
    required: c.expected_calls.some(call => call.turn_index === i),
  })))
  for (const c of long) {
    assert.deepEqual(c.expected_calls.map(call => call.turn_index),
      c.turns.flatMap((_, i) => i % 2 ? [i] : []))
  }
  assert.equal(new Set(rows.map(r => r.user)).size, 154)
  assert.equal(new Set(rows.filter(r => r.required).map(r => r.user)).size, 128)
  assert.equal(new Set(rows.filter(r => !r.required).map(r => r.user)).size, 26)
  assert.match(guide, /154 distinct user utterances \(128 actionable, 26/u)
  assert.match(guide, /aggregate includes early and late turns/u)
  assert.match(guide, /offline\s+reaggregation/u)
})

function fraction(cell) {
  const match = /^(\d+\.\d+)% \((\d+)\/(\d+)\)$/u.exec(cell)
  assert.ok(match, `expected percentage plus numerator/denominator: ${cell}`)
  const [, percent, n, d] = match
  assert.ok(Number(n) <= Number(d) && Number(d) > 0)
  assert.equal((Number(n) / Number(d) * 100).toFixed(2), percent)
  return { n: Number(n), d: Number(d) }
}

test('accuracy tables retain count arithmetic, metric units and source distinctions', () => {
  const shortSection = results.split('## Short cases')[1].split('## Long dialogue')[0]
  const shortRows = tableRows(shortSection).slice(1)
  assert.equal(shortRows.length, 5)
  for (const row of shortRows) {
    for (const cell of row.slice(2)) assert.equal(fraction(cell).d, Number(row[1]))
  }
  for (let column = 2; column < shortRows[0].length; column++) {
    assert.equal(shortRows.slice(0, 4).reduce((sum, row) => sum + fraction(row[column]).n, 0),
      fraction(shortRows[4][column]).n)
  }
  const longSection = results.split('## Long dialogue')[1].split('## Supplemental')[0]
  const rows = tableRows(longSection).slice(1)
  assert.equal(rows.length, 5)
  for (const row of rows) {
    const [overall, tool, noTool] = row.slice(1).map(fraction)
    assert.deepEqual([overall.d, tool.d, noTool.d], [500, 250, 250])
    assert.equal(overall.n, tool.n + noTool.n)
  }
  assert.match(results, /team-provided per-turn aggregates/u)
  assert.match(results, /do\s+not have matching raw traces/u)
  assert.match(results, /repeat is deliberately kept separate/u)
  assert.match(results, /not evidence that the models failed\s+on the same case/u)
})

test('maintained example documentation uses resolvable local links', () => {
  const docs = ['README.md', 'README_ZH.md', 'bench/README.md', 'agent/README.md',
    'gateway/README.md', 'client/README.md', 'service/README.md', 'service/tools/README.md',
    ...['vehicle', 'music', 'navigation'].map(domain => `service/tools/${domain}/README.md`)]
  for (const directory of ['docs', 'bench/results']) {
    docs.push(...readdirSync(resolve(root, directory)).filter(file => file.endsWith('.md'))
      .map(file => `${directory}/${file}`))
  }
  for (const file of docs) {
    const text = read(file).replace(/```[\s\S]*?```/gu, '')
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/gu)) {
      const href = match[1]
      if (/^[a-z][a-z0-9+.-]*:/iu.test(href)) continue
      const [relative, fragment] = href.split('#')
      const target = relative ? resolve(root, dirname(file), decodeURIComponent(relative)) : resolve(root, file)
      assert.ok(existsSync(target), `${file}: missing ${href}`)
      if (fragment && extname(target) === '.md') {
        const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gmu)]
          .map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/gu, '-'))
        assert.ok(headings.includes(decodeURIComponent(fragment)), `${file}: missing anchor ${href}`)
      }
    }
  }
})
