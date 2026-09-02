#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

// 仅记录没有上游修复版本、且不进入生产依赖的构建链问题。已修复或不再
// 出现的例外必须及时删除，脚本会在例外失效时强制报错提醒。
const TEMPORARY_BUILD_ADVISORIES = new Map([
  [1102341, {
    id: 'GHSA-67mh-4wv8-2f99',
    expires: '2026-11-30',
    reason: 'VitePress 1.6.4 的开发服务器间接依赖；npm 当前无可用修复，且不进入生产依赖',
  }],
  [1116229, {
    id: 'GHSA-4w7w-66w2-5vf9',
    expires: '2026-11-30',
    reason: 'VitePress 1.6.4 的开发服务器间接依赖；npm 当前无可用修复，且不进入生产依赖',
  }],
  [1120784, {
    id: 'GHSA-v6wh-96g9-6wx3',
    expires: '2026-11-30',
    reason: 'VitePress 1.6.4 的开发服务器间接依赖；npm 当前无可用修复，且不进入生产依赖',
  }],
  [1123525, {
    id: 'GHSA-fx2h-pf6j-xcff',
    expires: '2026-11-30',
    reason: 'VitePress 1.6.4 的开发服务器间接依赖；npm 当前无可用修复，且不进入生产依赖',
  }],
])

function runAudit(args) {
  const npmExecutable = process.env.npm_execpath
  const command = npmExecutable
    ? process.execPath
    : process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(command, [
    ...(npmExecutable ? [npmExecutable] : []),
    'audit',
    '--json',
    ...args,
  ], {
    encoding: 'utf8',
    env: process.env,
  })
  if (result.error) throw result.error
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    process.stderr.write(result.stderr || result.stdout)
    throw new Error('npm audit 没有返回有效 JSON')
  }
  return { report, status: result.status }
}

function terminalAdvisories(name, vulnerabilities, visited = new Set()) {
  if (visited.has(name)) return new Set()
  visited.add(name)
  const vulnerability = vulnerabilities[name]
  if (!vulnerability) return new Set()
  const terminals = new Set()
  for (const via of vulnerability.via || []) {
    if (typeof via === 'object' && Number.isInteger(via.source)) {
      terminals.add(via.source)
    } else if (typeof via === 'string') {
      for (const source of terminalAdvisories(via, vulnerabilities, visited)) {
        terminals.add(source)
      }
    }
  }
  return terminals
}

function assertProductionClean() {
  const { report, status } = runAudit(['--omit=dev', '--audit-level=high'])
  if (status !== 0 || report.metadata?.vulnerabilities?.high
    || report.metadata?.vulnerabilities?.critical) {
    throw new Error('生产依赖存在 high 或 critical 漏洞')
  }
}

function assertFullAuditIsExplicitlyAccountedFor() {
  const { report, status } = runAudit(['--audit-level=high'])
  if (status === 0) return
  const vulnerabilities = report.vulnerabilities || {}
  const unexpected = []
  const observedExceptions = new Set()
  for (const name of Object.keys(vulnerabilities)) {
    const sources = terminalAdvisories(name, vulnerabilities)
    if (!sources.size) {
      unexpected.push(`${name}: 无法解析根因 advisory`)
      continue
    }
    for (const source of sources) {
      const exception = TEMPORARY_BUILD_ADVISORIES.get(source)
      if (!exception) {
        unexpected.push(`${name}: npm advisory ${source}`)
        continue
      }
      observedExceptions.add(source)
      if (Date.now() > Date.parse(`${exception.expires}T23:59:59Z`)) {
        unexpected.push(`${name}: ${exception.id} 例外已于 ${exception.expires} 到期`)
      }
    }
  }
  if (unexpected.length) {
    throw new Error(`依赖审计发现未批准问题：${unexpected.join('；')}`)
  }
  for (const [source, exception] of TEMPORARY_BUILD_ADVISORIES) {
    if (!observedExceptions.has(source)) {
      throw new Error(
        `${exception.id}（${source}）已不再出现，请删除过期的审计例外`,
      )
    }
    process.stdout.write(
      `已记录临时构建链例外 ${exception.id}，到期日 ${exception.expires}：`
      + `${exception.reason}。\n`,
    )
  }
}

assertProductionClean()
assertFullAuditIsExplicitlyAccountedFor()
process.stdout.write('依赖审计通过。\n')
