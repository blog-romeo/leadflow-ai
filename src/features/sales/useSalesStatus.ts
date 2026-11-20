import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'

export interface SalesStatus {
  ai: { configured: boolean; missing: string[] }
  cost_tracking: boolean
  profile: { complete: boolean; missing: string[] }
}

/** Stato reale: AI configurata lato server e completezza del profilo commerciale. */
export function useSalesStatus(orgId: string | undefined) {
  const [status, setStatus] = useState<SalesStatus | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = useCallback(async () => {
    if (!orgId) return
    try {
      setStatus(await apiFetch<SalesStatus>(`/api/sales-agent/status?organization_id=${orgId}`))
      setError(null)
    } catch (e) {
      setError(e)
    }
  }, [orgId])
  useEffect(() => {
    void load()
  }, [load])
  return { status, error, reload: load }
}
