import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Megaphone, Plus, Send } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { OUTREACH_CHANNELS, WORKFLOW_STATUSES, type CampaignRow, type OutreachChannel, type WorkflowStatus } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { buttonClasses } from '../../components/ui/Button'
import { Select } from '../../components/ui/Field'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { CampaignStatusBadge, Kpi, periodRange, useAccounts, type Period } from '../../features/campaigns/shared'

export interface Metrics {
  campaigns: { total: number; running: number; draft: number; paused: number; completed: number }
  totals: {
    eligible: number
    excluded: number
    sent: number
    delivered: number
    bounced: number
    complaints: number
    contacted: number
    replies: number
    positive_confirmed: number
    positive_ai_unconfirmed: number
    appointments: number
    opportunities: number
    customers: number
  }
  rates: Record<'reply_rate' | 'appointment_rate' | 'conversion_rate' | 'bounce_rate', { numerator: number; denominator: number; denominator_label: string; value: number | null }>
  revenue: { currency: string; amount: number; opportunities: number }[]
  by_campaign: { id: string; name: string; status: WorkflowStatus; channel: OutreachChannel; created_at: string; eligible: number; excluded: number; sent: number; delivered: number; replies: number; appointments: number; opportunities: number; customers: number; contacted: number; bounced: number }[]
  weekly_sent: { week: string; sent: number }[]
}

export function useCampaignFilters() {
  const [period, setPeriod] = useState<Period>('d30')
  const [campaign, setCampaign] = useState('')
  const [channel, setChannel] = useState<OutreachChannel | ''>('')
  const [status, setStatus] = useState<WorkflowStatus | ''>('')
  return { period, setPeriod, campaign, setCampaign, channel, setChannel, status, setStatus }
}

export function CampaignFilters({ f, campaigns }: { f: ReturnType<typeof useCampaignFilters>; campaigns: Pick<CampaignRow, 'id' | 'name'>[] }) {
  const { t } = useI18n()
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Select label={t('cm.filters.period')} value={f.period} onChange={(e) => f.setPeriod(e.target.value as Period)}>
        {(['d7', 'd30', 'd90', 'd365'] as const).map((p) => (
          <option key={p} value={p}>
            {t(`cm.filters.periods.${p}`)}
          </option>
        ))}
      </Select>
      <Select label={t('cm.filters.campaign')} value={f.campaign} onChange={(e) => f.setCampaign(e.target.value)}>
        <option value="">{t('cm.filters.all')}</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select label={t('cm.filters.channel')} value={f.channel} onChange={(e) => f.setChannel(e.target.value as OutreachChannel | '')}>
        <option value="">{t('cm.filters.allChannels')}</option>
        {OUTREACH_CHANNELS.map((c) => (
          <option key={c} value={c}>
            {t(`cm.channels.${c}`)}
          </option>
        ))}
      </Select>
      <Select label={t('cm.filters.status')} value={f.status} onChange={(e) => f.setStatus(e.target.value as WorkflowStatus | '')}>
        <option value="">{t('cm.filters.allStatuses')}</option>
        {WORKFLOW_STATUSES.map((s) => (
          <option key={s} value={s}>
            {t(`cm.status.${s}`)}
          </option>
        ))}
      </Select>
    </div>
  )
}

export function useMetrics(orgId: string, f: ReturnType<typeof useCampaignFilters>) {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [campaigns, setCampaigns] = useState<Pick<CampaignRow, 'id' | 'name'>[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    if (!supabase || !orgId) return
    setLoading(true)
    setError(false)
    const { from, to } = periodRange(f.period)
    const [m, list] = await Promise.all([
      supabase.rpc('campaign_metrics', { p_org: orgId, p_from: from, p_to: to, p_campaign: f.campaign || null, p_channel: f.channel || null, p_status: f.status || null }),
      supabase.from('campaigns').select('id, name').eq('organization_id', orgId).is('archived_at', null).order('created_at', { ascending: false }).limit(200),
    ])
    if (m.error) setError(true)
    else setMetrics(m.data as unknown as Metrics)
    setCampaigns((list.data ?? []) as Pick<CampaignRow, 'id' | 'name'>[])
    setLoading(false)
  }, [orgId, f.period, f.campaign, f.channel, f.status])
  useEffect(() => {
    void load()
  }, [load])
  return { metrics, campaigns, error, loading, reload: load }
}

export default function Campaigns() {
  const { t, formatNumber, formatDate } = useI18n()
  const { currentOrg } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const f = useCampaignFilters()
  const { metrics, campaigns, error, loading, reload } = useMetrics(orgId, f)
  const { accounts, connected } = useAccounts(orgId)
  const n = (v: number | undefined) => formatNumber(v ?? 0)

  return (
    <>
      <PageHeader
        title={t('cm.title')}
        subtitle={t('cm.subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/app/settings/channels" className={buttonClasses('secondary', 'md')}>
              <Send className="size-4" aria-hidden />
              {t('cm.channelsLink')}
            </Link>
            <Link to="/app/campaigns/new" className={buttonClasses('primary', 'md')}>
              <Plus className="size-4" aria-hidden />
              {t('cm.new')}
            </Link>
          </div>
        }
      />
      <div className="space-y-5">
        {accounts && connected.length === 0 && (
          <InlineAlert tone="signal">
            {t('cm.noProvider')}{' '}
            <Link to="/app/settings/channels" className="underline">
              {t('cm.noProviderCta')}
            </Link>
          </InlineAlert>
        )}
        <CampaignFilters f={f} campaigns={campaigns} />
        {loading && !metrics ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={t('cm.errors.generic')} onRetry={() => void reload()} />
        ) : (
          metrics && (
            <>
              <section aria-label={t('cm.title')} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                <Kpi label={t('cm.kpi.total')} value={n(metrics.campaigns.total)} />
                <Kpi label={t('cm.kpi.running')} value={n(metrics.campaigns.running)} />
                <Kpi label={t('cm.kpi.draft')} value={n(metrics.campaigns.draft)} />
                <Kpi label={t('cm.kpi.completed')} value={n(metrics.campaigns.completed)} />
                <Kpi label={t('cm.kpi.eligible')} value={n(metrics.totals.eligible)} />
                <Kpi label={t('cm.kpi.sent')} value={n(metrics.totals.sent)} />
                <Kpi label={t('cm.kpi.replies')} value={n(metrics.totals.replies)} />
                <Kpi label={t('cm.kpi.appointments')} value={n(metrics.totals.appointments)} hint={t('cm.kpi.attributionHint')} />
                <Kpi label={t('cm.kpi.opportunities')} value={n(metrics.totals.opportunities)} hint={t('cm.kpi.attributionHint')} />
                <Kpi label={t('cm.kpi.conversions')} value={n(metrics.totals.customers)} hint={t('cm.kpi.attributionHint')} />
              </section>
              <p className="text-xs text-muted">{t('cm.realEvents')}</p>
              <Panel title={t('cm.list.title')}>
                {metrics.by_campaign.length === 0 ? (
                  <EmptyState
                    icon={Megaphone}
                    title={t('cm.list.empty')}
                    action={
                      <Link to="/app/campaigns/new" className={buttonClasses('primary', 'md')}>
                        {t('cm.new')}
                      </Link>
                    }
                  />
                ) : (
                  <div className="-mx-5 overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm">
                      <caption className="sr-only">{t('cm.list.title')}</caption>
                      <thead>
                        <tr className="border-b border-line text-left text-xs text-muted">
                          <th scope="col" className="px-5 py-2 font-medium">{t('cm.list.name')}</th>
                          <th scope="col" className="px-3 py-2 font-medium">{t('cm.list.status')}</th>
                          <th scope="col" className="px-3 py-2 font-medium">{t('cm.list.channel')}</th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">{t('cm.list.recipients')}</th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">{t('cm.list.sent')}</th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">{t('cm.list.replies')}</th>
                          <th scope="col" className="px-5 py-2 text-right font-medium">{t('cm.list.created')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metrics.by_campaign.map((c) => (
                          <tr key={c.id} className="border-b border-line/70 last:border-0">
                            <td className="px-5 py-2.5">
                              <Link to={`/app/campaigns/${c.id}`} className="font-medium text-flow hover:underline">
                                {c.name}
                              </Link>
                            </td>
                            <td className="px-3 py-2.5"><CampaignStatusBadge status={c.status} /></td>
                            <td className="px-3 py-2.5 text-muted">{t(`cm.channels.${c.channel}`)}</td>
                            <td className="px-3 py-2.5 text-right tabular">{n(c.eligible)} / {n(c.excluded)}</td>
                            <td className="px-3 py-2.5 text-right tabular">{n(c.sent)}</td>
                            <td className="px-3 py-2.5 text-right tabular">{n(c.replies)}</td>
                            <td className="px-5 py-2.5 text-right text-muted">{formatDate(c.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </>
          )
        )}
      </div>
    </>
  )
}
