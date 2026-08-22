import { useEffect, useMemo, useRef, useState } from 'react'

import { NativeInputDictationClient } from './native-input-dictation.js'

export default function DesktopNativeInputController({
  capability,
  events,
  requestVoice,
  voice,
}) {
  const [available, setAvailable] = useState(false)
  const [view, setView] = useState({ state: 'disabled', error: '' })
  const [pendingStart, setPendingStart] = useState(false)
  const gates = useRef({ capability, voice })
  gates.current = { capability, voice }
  const api = window.qwenAudioAgentDesktop

  const client = useMemo(() => new NativeInputDictationClient({
    enabled: true,
    canStart: () => (
      gates.current.capability === true
      && gates.current.voice.ownership?.state === 'active'
      && gates.current.voice.hostInputSuspended !== true
      && gates.current.voice.inputReady === true
    ),
    sendGateway: event => gates.current.voice.sendGatewayEvent(event),
    sendNative: operation => api.nativeInputOperation(operation),
    setCapture: (...args) => gates.current.voice.setDictationCapture(...args),
    onView: setView,
  }), [api])

  useEffect(() => {
    let disposed = false
    api.nativeInputStatus()
      .then(status => {
        if (!disposed) setAvailable(
          status?.enabled === true
          && status?.state === 'ready'
          && status?.lifecycle?.state === 'ready',
        )
      })
      .catch(() => { if (!disposed) setAvailable(false) })
    return () => { disposed = true }
  }, [api])

  useEffect(() => api.onNativeInputSessionRequest(() => {
    if (!available) return
    if (client.view().active) client.cancel('user_cancelled')
    else if (
      voice.inputReady === true
      && voice.ownership?.state === 'active'
      && voice.hostInputSuspended !== true
    ) void client.start()
    else {
      requestVoice()
      setPendingStart(true)
    }
  }), [api, available, client, requestVoice, voice])

  useEffect(() => {
    if (!pendingStart) return undefined
    if (
      capability === true
      && voice.inputReady === true
      && voice.ownership?.state === 'active'
      && voice.hostInputSuspended !== true
    ) {
      setPendingStart(false)
      void client.start()
      return undefined
    }
    const timer = setTimeout(() => {
      setPendingStart(false)
      setView({
        state: 'error',
        error: 'Input · microphone unavailable',
      })
    }, 5_000)
    return () => clearTimeout(timer)
  }, [capability, client, pendingStart, voice])

  useEffect(() => {
    const item = events.at(-1)
    if (item) client.handle(item.event)
  }, [client, events])

  useEffect(() => () => {
    if (client.view().active) client.cancel('renderer_unmounted')
  }, [client])

  if (!available) return null
  return <output
    className={`desktop-native-input-status ${view.state}`}
    aria-live="polite"
    title={view.error || view.state}
  >{view.error || `Input · ${pendingStart ? 'starting' : view.state}`}</output>
}
