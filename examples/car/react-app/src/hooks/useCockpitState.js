import { useCallback, useEffect, useState } from 'react'
import {
  isTerminalNavigationProgress,
  navigationProgressFromActivity,
} from '../navigation-progress'
import { applyCockpitStateUpdate } from '../cockpit-state-update'

function domainOrigin() {
  return import.meta.env.VITE_COCKPIT_DOMAIN_ORIGIN || 'http://127.0.0.1:3010'
}

export default function useCockpitState(cockpitId) {
  const [state, setState] = useState(null)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let disposed = false
    let progressTimer = null
    const query = new URLSearchParams({ cockpitId })
    const stateUrl = `${domainOrigin()}/api/cockpit/state?${query}`
    const eventsUrl = `${domainOrigin()}/api/cockpit/events?${query}`

    fetch(stateUrl)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then(value => {
        if (!disposed) {
          setState(value)
          setError(null)
        }
      })
      .catch(reason => {
        if (!disposed) setError(reason?.message || '座舱状态服务不可用')
      })

    const events = new EventSource(eventsUrl)
    events.addEventListener('snapshot', event => {
      if (!disposed) setState(JSON.parse(event.data))
    })
    events.addEventListener('state', event => {
      if (!disposed) {
        const update = JSON.parse(event.data)
        setState(previous => applyCockpitStateUpdate(previous, update))
      }
    })
    events.addEventListener('activity', event => {
      if (disposed) return
      const next = navigationProgressFromActivity(JSON.parse(event.data))
      if (!next) return
      clearTimeout(progressTimer)
      setProgress(next)
      if (isTerminalNavigationProgress(next)) {
        progressTimer = setTimeout(() => {
          if (!disposed) setProgress(null)
        }, 1800)
      }
    })
    events.addEventListener('open', () => {
      if (!disposed) setError(null)
    })
    events.addEventListener('error', () => {
      if (!disposed) setError('座舱状态连接中断，正在重连')
    })
    return () => {
      disposed = true
      clearTimeout(progressTimer)
      events.close()
    }
  }, [cockpitId])

  const execute = useCallback(async (name, args = {}) => {
    const response = await fetch(`${domainOrigin()}/api/cockpit/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cockpitId, name, arguments: args }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
    return result
  }, [cockpitId])

  return { state, progress, error, execute }
}
