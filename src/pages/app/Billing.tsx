import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { SubscriptionRow } from '../../lib/database.types'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { ErrorState, LoadingState } from '../../components/ui/States'
import ModulePreview from './ModulePreview'

export default function Billing() {
  const { t, formatDate } = useI18n()
  const { currentOrg, isOrgAdmin } = useAuth()
  const [sub, setSub] = useState<SubscriptionRow | null>(null)
  const [loading, setLoading] = useState(isOrgAdmin)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!supabase || !currentOrg || !isOrgAdmin) return
    let active = true
    setLoading(true)
    supabase
      .from('subscriptions')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (!active) return
        setError(!!err)
        setSub(data)
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [currentOrg, isOrgAdmin])

  return (
    <ModulePreview moduleKey="billing">
      <Panel title={t('billing.currentPlan')}>
        {!isOrgAdmin ? (
          <p className="text-sm text-muted">{t('billing.adminOnly')}</p>
        ) : loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={t('errors.generic')} />
        ) : sub ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-display text-xl font-semibold capitalize">{sub.plan}</span>
            <Badge tone="flow">{sub.status}</Badge>
            {sub.current_period_end && <span className="text-sm text-muted">{formatDate(sub.current_period_end)}</span>}
          </div>
        ) : (
          <p className="text-sm text-muted">{t('billing.noSubscription')}</p>
        )}
      </Panel>
    </ModulePreview>
  )
}
