import { z } from 'zod'
import { MultiZoneCoordinator } from './coordinator.mjs'
import { CockpitSmartTurn } from './smart-turn.mjs'

export const MULTI_ZONE_EVENT = 'cockpit.multi_zone.input'
export const MULTI_ZONE_STATE = 'cockpit.multi_zone'
const zone = z.enum(['driver', 'passenger', 'rearLeft', 'rearRight'])
const row = z.object({ zone, text: z.string().trim().min(1).max(2000) }).strict()
const schema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('enable') }).strict(),
  z.object({ op: z.literal('disable') }).strict(),
  z.object({ op: z.literal('audio.stop') }).strict(),
  z.object({ op: z.literal('audio'), audio: z.string().min(4).max(16_384).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  z.object({ op: z.literal('text'), rows: z.array(row).min(1).max(4).refine(rows => new Set(rows.map(r => r.zone)).size === rows.length, '重复音区') }).strict(),
])

export function createMultiZoneEvents({ mergeMs = 300, timeoutMs = 30_000 } = {}) {
  const sessions = new Map()
  const definition = {
    name: MULTI_ZONE_EVENT, schema, maxBytes: 24_576,
    rateLimit: { max: 1000, windowMs: 10_000 }, retention: 'transient', route: 'handle',
    handle(event, effects) {
      const key = JSON.stringify(event.source)
      let session = sessions.get(key)
      const publish = () => effects.publishClientState(MULTI_ZONE_STATE, {
        enabled: Boolean(session), wakeZone: 'driver', asr: 'Smart Turn', driverTranscript: session?.smartTurn?.lastText || '',
        driverSpeaking: [...(session?.smartTurn?.items.values() || [])].some(item => !item.ended),
        ...(session?.coordinator.snapshot() || { batch: null, history: [] }),
      })
      const close = () => {
        session?.unsubscribe?.()
        session?.unsubscribeRealtime?.()
        session?.smartTurn.close()
        session?.coordinator.close()
        sessions.delete(key)
        session = null
      }
      if (event.data.op === 'enable') {
        if (session) return publish()
        session = {}
        session.coordinator = new MultiZoneCoordinator({
          submit: effects.submitInput,
          collect: active => {
            effects.setExternalInput(active, { audioInput: true })
            effects.setInputCollecting(active)
          },
          beforeSubmit: () => session.smartTurn.waitForIdle(),
          publish, mergeMs, timeoutMs,
        })
        session.smartTurn = new CockpitSmartTurn({ coordinator: session.coordinator, publish })
        sessions.set(key, session)
        session.unsubscribeRealtime = effects.onRealtimeEvent(event => session?.smartTurn.receive(event))
        session.unsubscribe = effects.onDisconnect(close)
        return publish()
      }
      if (event.data.op === 'disable') {
        close()
        return publish()
      }
      if (!session) throw new Error('请先开启四音区模拟')
      if (event.data.op === 'text') session.smartTurn.text(event.data.rows, event.id)
      // Compatibility for older demo clients/benchmarks. The browser sends
      // ordinary audio.append in both screens, preserving the native VAD path.
      if (event.data.op === 'audio') effects.appendAudio(event.data.audio)
      if (event.data.op === 'audio.stop') {
        // Feed silence so Smart Turn can finish; a mute click never creates
        // a synthetic speech_stopped event or bypasses semantic turn detection.
        for (let i = 0; i < 20; i++) effects.appendAudio(Buffer.alloc(3200).toString('base64'))
      }
    },
  }
  return {
    definitions: [definition],
    close() {
      for (const session of sessions.values()) {
        session.unsubscribe?.()
        session.unsubscribeRealtime?.()
        session.smartTurn.close()
        session.coordinator.close()
      }
      sessions.clear()
    },
  }
}
