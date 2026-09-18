import { captureFrame, CAPTURE_ACTION } from './frame.mjs'
import { VisualObservers } from './observers.mjs'

function tool(name, description, properties, required = []) {
  return { name, policy: { maxResultBytes: 24_000 }, definition: {
    type: 'function', function: { name, description,
      parameters: { type: 'object', properties, required, additionalProperties: false } },
  } }
}

export function createVisionTools({ reader, observers = new VisualObservers({ reader }) }) {
  const captures = new Set()
  const catalog = [
    tool('capture_visual', 'Read one fresh frame from the client\'s user-selected visual source. Use when an answer needs current visual evidence. Returns an Omni visual description and an input reference usable by spawn_thinking for further work; never claims the coding backend has seen a live stream. Does not start continuous monitoring.', {
      question: { type: 'string', description: 'What to inspect or read from the current image, in the user\'s language.' },
    }, ['question']),
    tool('visual_observation', 'Manage explicitly requested, bounded visual observation. start watches for a visible condition or narrates changes; list reports actual status; stop cancels one ID or all current observations when ID is omitted. Only start narration when requested. The client must have an authorized visual source. This is sampled observation, not a safety-critical alarm or a recording service.', {
      operation: { type: 'string', enum: ['start', 'list', 'stop'] },
      focus: { type: 'string', description: 'Visible condition to watch or topic to narrate; required for start.' },
      mode: { type: 'string', enum: ['condition', 'narration'] },
      duration_seconds: { type: 'integer', minimum: 10, maximum: 600, description: 'Defaults to 120 seconds.' },
      repeat: { type: 'boolean', description: 'For condition mode, notify again only after the condition clears and recurs. Default false.' },
      id: { type: 'string', description: 'Existing observation ID for stop; omit to stop all.' },
    }, ['operation']),
  ]
  return {
    describe: () => ({ key: 'x-omni-vision', label: 'X-Omni visual tools' }),
    initialize: async () => {},
    tools: () => catalog,
    health: () => ({ ok: true }),
    observers,
    invalidateSession(source) {
      observers.stopSession(source)
      for (const pending of captures) {
        if (pending.ownerId === source.ownerId && pending.sessionId === source.sessionId) pending.controller.abort()
      }
    },
    async execute(name, args = {}, context = {}) {
      try {
        if (context.signal?.aborted || !context.supportsClientAction?.(CAPTURE_ACTION)) {
          throw new Error('This client has no available visual capture action')
        }
        if (name === 'capture_visual') {
          if (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 2_000) {
            throw new Error('A bounded visual question is required')
          }
          const pending = { ownerId: context.ownerId, sessionId: context.sessionId, controller: new AbortController() }
          captures.add(pending)
          const signal = AbortSignal.any([context.signal, pending.controller.signal])
          try {
            const frame = await captureFrame(context, { signal })
            const description = await reader.read(frame, args.question, { signal })
            if (signal.aborted || context.isCurrent?.() === false) throw new Error('Visual request was interrupted')
            const inputs = context.registerInputs([{
              type: 'file', mime: 'image/jpeg', filename: `${frame.source}.jpg`,
              url: `data:image/jpeg;base64,${frame.image}`,
            }], context.turnId)
            return { status: 'completed', source: frame.source, captured_at: frame.capturedAt,
              description, input_refs: inputs.map(input => input.ref) }
          } finally { captures.delete(pending) }
        }
        if (name !== 'visual_observation') throw new Error('Unknown visual tool')
        if (args.operation === 'list') return { observations: observers.list(context) }
        if (args.operation === 'stop') {
          const ids = args.id ? [args.id] : observers.list(context).map(item => item.id)
          return { status: 'completed', stopped: ids.filter(id => observers.stop(id, context)) }
        }
        if (args.operation !== 'start') throw new Error('Invalid observation operation')
        return { status: 'started', observation: await observers.start({
          focus: args.focus, mode: args.mode, durationSeconds: args.duration_seconds, repeat: args.repeat,
        }, context) }
      } catch (error) {
        return { status: 'failed', message: error.message }
      }
    },
    close() {
      for (const pending of captures) pending.controller.abort()
      observers.close()
      reader.close()
    },
  }
}
