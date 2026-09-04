import { useCallback, useMemo, useState } from 'react'
import { gatewayHttpUrl } from '../config/gateway'
import { memoryItemsFromDocuments } from '../projections/memory-items'

async function responsePayload(response) {
  return response.json().catch(() => ({}))
}

export default function useGatewayMemory() {
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(gatewayHttpUrl('/api/memory'))
      const payload = await responsePayload(response)
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      setDocuments(Array.isArray(payload.documents) ? payload.documents : [])
      setError(null)
    } catch (reason) {
      setError(reason?.message || '记忆服务不可用')
    } finally {
      setLoading(false)
    }
  }, [])

  const remove = useCallback(async (item) => {
    try {
      const response = await fetch(gatewayHttpUrl('/api/memory'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [{
            document: item.scope,
            expectedRevision: item.revision,
            edits: [{ old_text: item.oldText, new_text: '' }],
          }],
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
      setError(reason?.message || '删除记忆失败')
      if (reason?.stale) await load()
      return false
    }
  }, [load])

  return {
    items: useMemo(() => memoryItemsFromDocuments(documents), [documents]),
    loading,
    error,
    load,
    remove,
  }
}
