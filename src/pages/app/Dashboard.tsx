import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, CircleDashed, Inbox } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { PIPELINE_STAGES, type ActivityRow, type LeadStatus } from '../../lib/database.types'
import { MODULES } from '../../config/modules'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States'
import { cn } from '../../lib/cn'

const PIPELINE: LeadStatus[] = PIPELINE_STAGES

interface DashboardData {
  byStatus: Record<LeadStatus, number>
  activeCampaigns: number
  upcomingAppointments: number
  activities: Pick<ActivityRow, 'id' | 'type' | 'subject' | 'occurred_at'>[]
  sources: number
  candidates: number
}

function useDashboardData(orgId: string | undefined) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!supabase || !orgId) return
    setLoading(true)
    setError(false)
    const db = supabase
    const statusCounts = PIPELINE.map((s) =>
      db.from('leads').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).is('deleted_at', null).eq('status', s),
    )
    const [sources, candidates, campaigns, appointments, activities, ...statuses] = await Promise.all([
      db.from('lead_sources').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
      db.from('lead_candidates').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).neq('status', 'excluded'),
      db.from('campaigns').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'active'),
      db
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('status', 'scheduled')
        .gte('starts_at', new Date().toISOString()),
      db.from('activities').select('id, type, subject, occurred_at').eq('organization_id', orgId).order('occurred_at', { ascending: false }).limit(5),
      ...statusCounts,
    ])
    const failed = [sources, candidates, campaigns, appointments, activities, ...statuses].some((r) => r.error)
    if (failed) {
      setError(true)
      setLoading(false)
      return
    }
    const byStatus = Object.fromEntries(PIPELINE.map((s, i) => [s, statuses[i]?.count ?? 0])) as Record<LeadStatus, number>
    setData({
      byStatus,
      activeCampaigns: campaigns.count ?? 0,
      upcomingAppointments: appointments.count ?? 0,
      activities: (activities.data ?? []) as DashboardData['activities'],
      sources: sources.count ?? 0,
      candidates: candidates.count ?? 0,
    })
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  return { data, error, loading, reload: load }
}

function Kpi({ label, value, loading }: { label: string; value: number | undefined; loading: boolean }) {
  const { t, formatNumber } = useI18n()
  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface px-5 py-4">
      <p className="text-sm text-muted">{label}</p>
      {loading ? (
        <div className="mt-2 h-8 w-12 animate-pulse rounded bg-surface-2" aria-hidden />
      ) : (
        <p className="mt-1 font-display text-3xl font-semibold tabular">{formatNumber(value ?? 0)}</p>
      )}
      {!loading && !value && <p className="mt-0.5 text-xs text-muted">{t('dashboard.kpiNoData')}</p>}
    </div>
  )
}

function Pipeline({ byStatus }: { byStatus: Record<LeadStatus, number> }) {
  const { t, formatNumber } = useI18n()
  const total = PIPELINE.reduce((acc, s) => acc + byStatus[s], 0)
  return (
    <div>
      <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-control)] border border-line bg-line sm:grid-cols-4 lg:grid-cols-6">
        {PIPELINE.map((s) => {
          const n = byStatus[s]
          const share = total ? n / total : 0
          return (
            <li key={s} className="relative bg-surface px-4 py-3">
              <p className="text-xs text-muted">{t(`status.${s}`)}</p>
              <p className={cn('mt-0.5 font-display text-xl font-semibold tabular', n === 0 && 'text-muted')}>{formatNumber(n)}</p>
              {/* Barra proporzionale alla quota del totale: assente se non ci sono dati. */}
              <span
                className={cn('absolute bottom-0 left-0 h-0.5', s === 'won' ? 'bg-ok' : s === 'lost' ? 'bg-danger' : 'bg-flow')}
                style={{ width: `${share * 100}%` }}
                aria-hidden
              />
            </li>
          )
        })}
      </ol>
      {total === 0 && <p className="mt-3 text-sm text-muted">{t('dashboard.pipelineEmpty')}</p>}
    </div>
  )
}

export default function Dashboard() {
  const { t, formatDate } = useI18n()
  const { currentOrg, profile } = useAuth()
  const { data, error, loading, reload } = useDashboardData(currentOrg?.id)
  const firstName = profile?.full_name?.split(' ')[0]
  const totalLeads = data ? PIPELINE.reduce((a, s) => a + data.byStatus[s], 0) : undefined
  const aiModules = MODULES.filter((m) => m.group === 'ai')

  const steps: { label: string; done: boolean; to?: string; soon?: boolean }[] = [
    { label: t('dashboard.stepOrg'), done: true },
    { label: t('dashboard.stepProfile'), done: false, to: '/app/lead-scoring' },
    { label: t('dashboard.stepFind'), done: (data?.candidates ?? 0) > 0 || (data?.sources ?? 0) > 0, to: '/app/lead-finder' },
    { label: t('dashboard.stepLeads'), done: (totalLeads ?? 0) > 0, to: '/app/lead-finder' },
    { label: t('dashboard.stepTeam'), done: false, soon: true },
  ]

  return (
    <>
      <PageHeader
        title={firstName ? t('dashboard.greeting', { name: firstName }) : t('dashboard.greetingFallback')}
        subtitle={t('dashboard.subtitle', { org: currentOrg?.name ?? '' })}
      />

      {error ? (
        <Panel>
          <ErrorState message={t('dashboard.loadError')} onRetry={() => void reload()} />
        </Panel>
      ) : (
        <div className="space-y-6">
          <section aria-label="KPI" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={t('dashboard.kpiLeads')} value={totalLeads} loading={loading} />
            <Kpi label={t('dashboard.kpiQualified')} value={data?.byStatus.qualified} loading={loading} />
            <Kpi label={t('dashboard.kpiCampaigns')} value={data?.activeCampaigns} loading={loading} />
            <Kpi label={t('dashboard.kpiAppointments')} value={data?.upcomingAppointments} loading={loading} />
          </section>

          <Panel title={t('dashboard.pipelineTitle')}>{loading || !data ? <LoadingState /> : <Pipeline byStatus={data.byStatus} />}</Panel>

          <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
            <Panel title={t('dashboard.activityTitle')}>
              {loading ? (
                <LoadingState />
              ) : data && data.activities.length > 0 ? (
                <ul className="divide-y divide-line">
                  {data.activities.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <span className="truncate">{a.subject ?? a.type}</span>
                      <time className="shrink-0 text-muted" dateTime={a.occurred_at}>
                        {formatDate(a.occurred_at)}
                      </time>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={Inbox} title={t('dashboard.activityEmptyTitle')} body={t('dashboard.activityEmpty')} className="py-6" />
              )}
            </Panel>

            <Panel title={t('dashboard.nextStepsTitle')}>
              <ol className="space-y-3">
                {steps.map((s) => (
                  <li key={s.label} className="flex items-start gap-3 text-sm">
                    {s.done ? (
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-flow text-flow-ink">
                        <Check className="size-3" aria-hidden />
                      </span>
                    ) : (
                      <CircleDashed className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
                    )}
                    <span>
                      {s.to && !s.done ? (
                        <Link to={s.to} className="text-flow hover:underline">
                          {s.label}
                        </Link>
                      ) : (
                        <span className={cn(s.done && 'text-muted line-through decoration-line')}>{s.label}</span>
                      )}
                      {s.soon && <span className="block text-xs text-muted">{t('dashboard.stepSoon')}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </Panel>
          </div>

          <Panel title={t('dashboard.aiTitle')}>
            <p className="mb-4 max-w-2xl text-sm text-muted">{t('dashboard.aiBody')}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {aiModules.map(({ key, path, labelKey, icon: Icon, status }) => (
                <li key={key}>
                  <Link to={path} className="flex items-center gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2.5 text-sm hover:bg-surface-2">
                    <Icon className="size-4 text-flow" aria-hidden />
                    <span className="flex-1">{t(labelKey)}</span>
                    {status === 'available' ? <Badge tone="ok">{t('common.available')}</Badge> : <Badge tone="signal">{t('common.inPreparation')}</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}
    </>
  )
}
