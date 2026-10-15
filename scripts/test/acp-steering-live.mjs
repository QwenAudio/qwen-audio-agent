// Opt-in integration check. Uses the installed CLI and its existing credentials;
// never installs an Agent, changes config, or approves permission requests.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpProcessClient } from '../../server/src/backend/adapters/acp/process-client.mjs'
import { AcpTurnUpdates } from '../../server/src/backend/adapters/acp/turn-updates.mjs'

const commands = {
  qwen: ['qwen', '--acp'],
  opencode: ['opencode', 'acp'],
  qoder: ['qodercli', '--acp'],
  codex: ['codex-acp'],
}
const name = process.argv[2]
if (!commands[name]) throw new Error(`Choose an installed backend: ${Object.keys(commands).join(', ')}`)
const [command, ...args] = commands[name]
const directory = await mkdtemp(join(tmpdir(), 'qwa-steering-'))
const client = new AcpProcessClient({ label: name, command, args, cwd: directory, timeoutMs: 30_000 })
const counts = { prompt: 0, cancel: 0, steering: 0, drains: 0 }
for (const [method, counter] of [['prompt', 'prompt'], ['cancelSession', 'cancel'], ['steerSession', 'steering'], ['drainMidTurnQueue', 'drains']]) {
  const original = client[method].bind(client)
  client[method] = (...input) => { counts[counter] += 1; return original(...input) }
}
const started = Date.now()
try {
  await client.start()
  const session = await client.newSession({ cwd: directory, mcpServers: [] })
  const updates = new AcpTurnUpdates({ client, sessionId: session.sessionId, signal: AbortSignal.timeout(90_000) })
  let receipt
  let mode
  const result = await updates.run(
    '这是纯文本协议测试，不要调用任何工具，不要访问文件。请逐行输出从1到500的整数，每行一个。',
    { onUpdate(event) {
      if (receipt || event.sessionUpdate !== 'agent_message_chunk') return
      mode = client.steeringMode(session.sessionId)
      receipt = updates.enqueue('更正刚才的要求：停止输出数字。这是同一工作的调整。不要调用工具；只回复 STEERING_OK。')
    } },
  )
  assert.ok(receipt, 'no text update arrived while the prompt was active')
  await receipt.completion
  assert.match(result.content, /STEERING_OK/u)
  console.log(JSON.stringify({ backend: name, mode, counts, elapsedMs: Date.now() - started, passed: true }))
} finally {
  await client.close()
  await rm(directory, { recursive: true, force: true })
}
