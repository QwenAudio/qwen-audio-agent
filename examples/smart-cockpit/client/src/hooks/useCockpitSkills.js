import { useCallback, useEffect, useState } from 'react'

function serviceOrigin() {
  return import.meta.env.VITE_COCKPIT_SERVICE_ORIGIN || 'http://127.0.0.1:3010'
}

function skillUrl(cockpitId, skillId = '') {
  const query = new URLSearchParams({ cockpitId })
  const suffix = skillId ? `/${encodeURIComponent(skillId)}` : ''
  return `${serviceOrigin()}/api/cockpit/skills${suffix}?${query}`
}

async function jsonResponse(response) {
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
  return value
}

export default function useCockpitSkills(cockpitId, activity) {
  const [skills, setSkills] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    if (activity && !(
      activity.category === 'custom_skills'
      && activity.status === 'skills_changed'
    )) return undefined
    let disposed = false
    fetch(skillUrl(cockpitId))
      .then(jsonResponse)
      .then(value => {
        if (!disposed) {
          setSkills(Array.isArray(value) ? value : [])
          setError(null)
        }
      })
      .catch(reason => {
        if (!disposed) setError(reason?.message || '自定义技能服务不可用')
      })
    return () => { disposed = true }
  }, [activity, cockpitId])

  const load = useCallback((skillId) => (
    fetch(skillUrl(cockpitId, skillId)).then(jsonResponse)
  ), [cockpitId])

  const remove = useCallback(async (skillId) => {
    const removed = await fetch(skillUrl(cockpitId, skillId), {
      method: 'DELETE',
    }).then(jsonResponse)
    setSkills(previous => previous.filter(skill => skill.id !== removed.id))
    return removed
  }, [cockpitId])

  return { skills, error, load, remove }
}
