import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { ToolCallHandler } from '../src/frontend/tools/tool-call-handler.mjs'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'
import { asrReviewOptions } from '../src/frontend/tools/asr-review.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskOperations } from '../src/orchestration/task-operations.mjs'

const base = '76aec3e3'
const source = path => execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8', cwd: new URL('../../', import.meta.url) })

test('review switches independently override the legacy all-on/off default', () => {
  for (const frontend of ['on', 'off']) for (const backend of ['on', 'off']) {
    const options = asrReviewOptions({ QWEN_AUDIO_ASR_REVIEW: 'on', QWEN_AUDIO_ASR_FRONTEND_REVIEW: frontend, QWEN_AUDIO_ASR_DELEGATION_REVIEW: backend })
    assert.equal(options.frontend, frontend === 'on')
    assert.equal(options.backend, backend === 'on')
    assert.equal(options.enabled, frontend === 'on' || backend === 'on')
  }
})

test('main frontend prompt equals baseline after excluding only capability-query policy', () => {
  const current = readFileSync(new URL('../../config/frontend-agent/PROMPT.md', import.meta.url), 'utf8')
  const normalized = current.replace(/不要未经尝试就声称做不到，若准备以做不到为由拒绝请求，[\s\S]*?也不要用口头承诺、操作教程或替代方案代替执行。/,
    '不要未经尝试就声称做不到，也不要用口头承诺、操作教程或替代方案代替执行。')
  assert.equal(normalized, source('config/frontend-agent/PROMPT.md'))
})

test('both off matches executable baseline frontend dispatch, delegation backend input and receipts', async t => {
  const suffix = `.baseline-${process.pid}`
  const directory = new URL('../src/frontend/tools/', import.meta.url)
  const handlerFile = new URL(`${suffix}-handler.mjs`, directory)
  const agentFile = new URL(`${suffix}-agent.mjs`, directory)
  writeFileSync(agentFile, source('server/src/frontend/tools/agent-task-runtime.mjs'))
  writeFileSync(handlerFile, source('server/src/frontend/tools/tool-call-handler.mjs').replace("'./agent-task-runtime.mjs'", `'./${suffix}-agent.mjs'`))
  t.after(() => { unlinkSync(handlerFile); unlinkSync(agentFile) })
  const { ToolCallHandler: Baseline } = await import(handlerFile.href)
  async function run(Handler) {
    const inputs = [], outputs = [], executions = []
    const manager = new TaskManager()
    const operations = new TaskOperations({ taskManager: manager, backendRuntime: {
      run: async input => { inputs.push(input); return { content: 'query result' } },
      cancel: async () => ({}),
    } })
    const transcripts = new TurnTranscripts()
    const controller = new AbortController()
    controller.abort() // disabled mode must preserve original stale predicate
    const handler = new Handler({ taskManager: manager, taskOperations: operations,
      ownerId: 'o', sessionId: 's', transcripts, signal: controller.signal,
      asrReview: { enabled: false, frontend: false, backend: false, delegation: 'dual-query' },
      getTurnId: () => 't', getTurnGeneration: () => 1,
      getFrontend: () => ({ sendFunctionOutput: async (_id, result) => outputs.push(result) }),
    })
    assert.equal(handler.isStale('t', 1), false)
    await handler.executeExternalToolCall({ tool: { name: 'lookup' }, source: { execute: async (name, args) => { executions.push({ name, args }); return { found: true } } } },
      { callId: 'external', turnId: 't', turnGeneration: 1, args: { name: 'Yusuf Rossi' } })
    await handler.executeSpawnThinkingToolCall({ callId: 'spawn', turnId: 't', generation: 1,
      args: { objective: 'lookup Yusuf Rossi' }, event: {}, callContext: {} })
    const task = operations.list({ ownerId: 'o', sessionId: 's' })[0]
    const completed = await manager.wait(task.id)
    transcripts.close()
    return { inputs, outputs: outputs.map(value => typeof value === 'string' ? value.replaceAll(task.id, '<task>') : { ...value, ...(value.task_id ? { task_id: '<task>' } : {}) }), executions,
      task: { kind: completed.kind, status: completed.status, result: completed.result } }
  }
  assert.deepEqual(await run(ToolCallHandler), await run(Baseline))
})
