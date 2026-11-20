import { useCallback, useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { LeadActivityRow } from '../../lib/database.types'
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States'
import { Badge } from '../../components/ui/Badge'

/** Cronologia del lead (vista lead_activities, filtrata da RLS). */
export function Timeline({ orgId, leadId, refreshKey }: { orgId: string; leadId: string; refreshKey: number }) {
  const { t, formatDate } = useI18n()
  const { user } = useAuth()
  const [rows, setRows] = useState<LeadActivityRow[] | null>(null)
  const [error, setError] = useState(false)
  const [names, setNames] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error: e } = await supabase.from('lead_activities').select('*').eq('organization_id', orgId).eq('lead_id', leadId).order('occurred_at', { ascending: false }).limit(100)
    setError(!!e)
    const list = (data ?? []) as unknown as LeadActivityRow[]
    setRows(list)
    const ids = [...new Set(list.map((r) => r.created_by).filter((x): x is string => !!x))]
    if (ids.length) {
      const { data: profiles } = await supabase.from('profiles').select('id, full_name, email').in('id', ids)
      setNames(Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name || p.email])))
    }
  }, [orgId, leadId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  if (error) return <ErrorState message={t('sales.errors.generic')} onRetry={() => void load()} />
  if (!rows) return <LoadingState />
  if (!rows.length) return <EmptyState icon={History} title={t('sales.timeline.empty')} />
  return (
    <ol className="relative space-y-4 border-l border-line pl-5">
      {rows.map((r) => {
        const who = !r.created_by ? t('sales.timeline.system') : r.created_by === user?.id ? t('sales.timeline.you') : (names[r.created_by] ?? t('sales.timeline.member'))
        const subject =
          r.type === 'status_change' && typeof r.metadata?.from === 'string' && typeof r.metadata?.to === 'string'
            ? `${t(`status.${r.metadata.from}`)} → ${t(`status.${r.metadata.to}`)}`
            : r.subject
        return (
          <li key={r.id} className="relative">
            <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-surface bg-flow" aria-hidden />
            <p className="text-sm">
              <Badge tone="neutral" className="mr-2">{t(`sales.timeline.types.${r.type}`)}</Badge>
              {subject}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              <time dateTime={r.occurred_at}>{formatDate(r.occurred_at)} {new Date(r.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> · {who}
            </p>
          </li>
        )
      })}
    </ol>
  )
}
