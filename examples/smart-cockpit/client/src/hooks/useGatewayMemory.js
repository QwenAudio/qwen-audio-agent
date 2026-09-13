import { useCallback, useMemo, useRef, useState } from 'react'
import { gatewayHttpUrl } from '../config/gateway'
import { memoryDeletionChange, memoryItemsFromDocuments } from '../projections/memory-items'

async function responsePayload(response) {
  return response.json().catch(() => ({}))
}

export default function useGatewayMemory() {
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const loadGenerationRef = useRef(0)

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current
    setLoading(true)
    try {
      const response = await fetch(gatewayHttpUrl('/api/memory'))
      const payload = await responsePayload(response)
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      if (generation !== loadGenerationRef.current) return
      setDocuments(Array.isArray(payload.documents) ? payload.documents : [])
      setError(null)
    } catch (reason) {
      if (generation !== loadGenerationRef.current) return
      setError(reason?.message || '记忆服务不可用')
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false)
    }
  }, [])

  const remove = useCallback(async (item) => {
    try {
      const change = memoryDeletionChange(documents, item)
      const response = await fetch(gatewayHttpUrl('/api/memory'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [change],
        }),
      })
      const payload = await responsePayload(response)
      if (!response.ok) {
        throw Object.assign(
          new Error(payload.error || `HTTP ${response.status}`),
          { stale: response.status === 409 },
        )
      }
      await load()
      return true
    } catch (reason) {
      if (reason?.stale) await load()
      setError(reason?.stale ? '记忆已更新，请重新选择要删除的条目。' : reason?.message || '删除记忆失败')
      return false
    }
  }, [documents, load])

  return {
    items: useMemo(() => memoryItemsFromDocuments(documents), [documents]),
    loading,
    error,
    load,
    remove,
  }
}
