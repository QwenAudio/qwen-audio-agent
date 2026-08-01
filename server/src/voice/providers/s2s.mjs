import { config } from '../../core/config.mjs'
import {
  TOOLS,
  buildFrontendInstructions,
  resultResponseInstructions,
  speakResponseInstructions,
  permissionResponseInstructions,
} from '../frontend-tools.mjs'
import { gaRealtimeProtocol } from './ga-protocol.mjs'

function classifyError(message) {
  // The single per-session response slot refuses concurrent response.create
  // requests. The frontend retries these transparently (singleResponseSlot).
  if (/another response is in progress/i.test(message)) return 'response_slot_busy'
  if (/no active response/i.test(message)) return 'no_active_response'
  return 'other'
}

// The s2s pipeline runs a generic chat model (e.g. qwen-plus) as its LLM.
// Unlike a realtime-tuned model, generic models tend to answer everything
// themselves, so the dispatch discipline has to be spelled out much more
// explicitly on top of the shared frontend prompt.
const dispatchInstructions = [
  '【调度红线】你是语音前台调度员，自己不执行任务，只能直接回答闲聊和不依赖时效的常识问答。',
  '遇到以下任何请求，必须立即调用 spawn_thinking 工具移交后台，绝不自行回答：',
  '查询实时或近期信息（新闻、天气、股价、赛事、军事动态等）、搜索、写代码、写文件、运行命令、操作电脑、查看屏幕或文件、创作长内容、继续或修改此前的工作。',
  '你已接入可联网的后台执行代理，查询能力永远可用；严禁声称“无法联网”“无法访问新闻或网络”“搜索能力不可用”，遇到此类需求一律调用 spawn_thinking。',
  '即使话题涉及战争、冲突等时政内容，转交后台客观查证也是正确做法，不要以敏感为由拒绝派单。',
  '严禁凭记忆回答需要最新信息的问题；严禁说“正在为你生成/查询”却不调用工具；严禁与此前的错误拒答保持一致，每一轮都按本红线重新判断。',
  '调用 spawn_thinking 前可先用一句话预告行动；询问已有任务的进展用 get_agent_task_status。',
].join(' ')

/**
 * huggingface/speech-to-speech cascaded front end (VAD -> STT -> LLM -> TTS)
 * behind its OpenAI Realtime compatible endpoint (--mode realtime).
 *
 * The wire dialect differences live in gaRealtimeProtocol. What remains here
 * are the *behavioural* gaps of the implementation, declared as capabilities
 * so the provider-agnostic frontend can compensate without ever naming this
 * provider. Every capability below was confirmed against s2s 0.2.11 sources
 * and live debugging sessions.
 */
export const s2sProvider = {
  key: 's2s',
  label: 'Speech-To-Speech',
  // The GA audio/pcm schema pins the sample rate to 24000 (pydantic hard
  // validation); a session.update declaring any other rate is rejected as a
  // whole, which silently drops instructions, tools and VAD configuration.
  inputSampleRate: 24000,
  outputSampleRate: config.s2sOutputSampleRate,
  protocol: gaRealtimeProtocol,

  capabilities: {
    // Injected conversation items are accepted but never echoed back as
    // conversation.item.created, so the frontend must not await confirmation.
    confirmsConversationItems: false,
    // interrupt_response cancels the in-flight response server-side when new
    // speech starts, but the cancelled response never receives a terminal
    // response.done event (the cancel path just flushes the queue).
    emitsTerminalEventOnInterrupt: false,
    // VAD-driven turns start generating without emitting response.created,
    // so any other response.* event must count as proof of generation.
    emitsResponseCreatedForServerTurns: false,
    // One response slot per session: a gateway response.create can race a
    // server-side VAD turn and gets refused instead of queued.
    singleResponseSlot: true,
  },
  // Last-resort guard for the idle gate: s2s responses finish within a few
  // seconds (LLM 1-2s + TTS at ~5x realtime), so any response id still marked
  // active after this long is bookkeeping leakage, not real work.
  idleGateTimeoutMs: 15000,
  // Local STT can take several seconds before the first response event.
  responseStartWatchdogMs: 45000,

  // The pipeline composes its own speech models; the interesting name to
  // report is the language model behind the voice.
  model: () => config.s2sModel,
  voice: () => config.s2sVoice || 'default',
  apiKey: () => config.s2sApiKey,
  missingKeyMessage: '请先配置 S2S_API_KEY（任意非空值即可）',
  connectTimeoutMessage: `连接 speech-to-speech 服务超时（${config.s2sRealtimeUrl}），请确认 s2s 已以 --mode realtime 启动`,

  url: () => config.s2sRealtimeUrl,
  headers: apiKey => ({ Authorization: `Bearer ${apiKey}` }),
  classifyError,

  buildSession: ({ agentContext }) => {
    const textOnly = agentContext?.textOnly === true
    return {
      // The GA schema requires a session type discriminator.
      type: 'realtime',
      instructions: [
        buildFrontendInstructions(agentContext),
        dispatchInstructions,
      ].join('\n\n'),
      // GA tools are flat objects rather than the beta { type, function } shape.
      tools: TOOLS.map(tool => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
      output_modalities: textOnly ? ['text'] : ['audio'],
      audio: {
        input: {
          // Only rate 24000 passes the GA schema validation.
          format: { type: 'audio/pcm', rate: 24000 },
          // input_audio_buffer.commit is unsupported: turns are cut by the
          // server-side VAD, so it has to be enabled explicitly.
          turn_detection: textOnly
            ? null
            : { type: 'server_vad', interrupt_response: true },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          ...(config.s2sVoice ? { voice: config.s2sVoice } : {}),
        },
      },
    }
  },

  // Out-of-band responses (conversation: 'none') are unsupported, so spoken
  // announcements become regular responses constrained by instructions.
  buildSpeakResponse: content => ({
    instructions: speakResponseInstructions(content),
    tool_choice: 'none',
  }),

  buildResultInjection: content => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }],
    },
    response: {
      tool_choice: 'none',
      instructions: resultResponseInstructions,
    },
  }),

  buildPermissionInjection: permission => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: [
          '<backend_permission_request>',
          `authorization_id=${permission.id}`,
          `operation=${permission.summary}`,
          '</backend_permission_request>',
        ].join('\n'),
      }],
    },
    response: {
      tool_choice: 'none',
      instructions: permissionResponseInstructions,
    },
  }),
}
