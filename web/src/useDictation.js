import { useCallback, useEffect, useMemo, useState } from 'react'
import { createDictationClient } from '../../shared/dictation-client.mjs'

const IDLE = Object.freeze({
  enabled: false,
  sessionId: '',
  state: 'idle',
  preview: '',
  capturing: false,
})

export default function useDictation({
  enabled,
  send,
  composerRef,
  locale,
  resetKey,
}) {
  const [status, setStatus] = useState({ ...IDLE, enabled })
  const client = useMemo(() => {
    // Reading resetKey makes a session change intentionally replace the
    // ephemeral controller without putting that key on the wire.
    void resetKey
    return createDictationClient({
      enabled,
      send,
      locale,
      composer: {
        snapshot: () => composerRef.current?.snapshot() || {
          text: '',
          selectionStart: 0,
          selectionEnd: 0,
          revision: 0,
        },
        applyOperation: operation => composerRef.current?.applyOperation(operation) || {
          applied: false,
          reason: 'composer_unavailable',
          revision: 0,
        },
        commitDictation: commitId => (
          composerRef.current?.commitDictation(commitId) === true
        ),
      },
    })
  }, [composerRef, enabled, locale, resetKey, send])

  useEffect(() => {
    setStatus(client.snapshot())
    const unsubscribe = client.subscribe(setStatus)
    return () => {
      unsubscribe()
      if (client.snapshot().capturing) client.cancel()
    }
  }, [client])

  const toggle = useCallback(() => {
    const current = client.snapshot()
    if (current.state === 'paused') return client.resume()
    if (current.capturing) return client.pause()
    return client.start()
  }, [client])

  return {
    ...status,
    start: useCallback(() => client.start(), [client]),
    pause: useCallback(() => client.pause(), [client]),
    resume: useCallback(() => client.resume(), [client]),
    cancel: useCallback(() => client.cancel(), [client]),
    toggle,
    appendAudio: useCallback(audio => client.appendAudio(audio), [client]),
    handleEvent: useCallback(event => client.handle(event), [client]),
  }
}
