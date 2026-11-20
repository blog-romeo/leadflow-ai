import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bot, Building2, KanbanSquare } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { PIPELINE_STAGES } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { buttonClasses, Button } from '../../components/ui/Button'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { cn } from '../../lib/cn'
import { useSalesStatus } from '../../features/sales/useSalesStatus'
import { BarList, ColumnChart } from '../../features/sales/Charts'
import { Copilot } from '../../features/sales/Copilot'
import { useMoney } from '../../features/sales/ProposalBuilder'

type Period = 'd7' | 'd30' | 'd90' | 'd365'
const DAYS: Record<Period, number> = { d7: 7, d30: 30, d90: 90, d365: 365 }

interface Dash {
  leads_available: number
  leads_qualified: number
  proposals_generated: number
  drafts_pending: number
  follow_ups_due: number
  follow_ups_overdue: number
  appointments_scheduled: number
  opportunities_open: number
  opportunities_open_value: number
  conversions: number
  by_stage: Record<string, number>
  weekly: { week: string; proposals: number; drafts_approved: number; conversions: number }[]
}
interface Usage {
  ai_generations: { used: number; limit: number }
  ai_tokens: { used: number; limit: number }
  ai_cost_usd: number | null
}
type Due = { id: string; title: string; due_at: string; lead_id: string; lead: { company_name: string } | null }
type Pending = { id: string; kind: 'draft' | 'proposal'; label: string; lead_id: string; company: string; created_at: string }
type Work = { id: string; company_name: string; score: number | null; priority: 'high' | 'medium' | 'low' | null; status: string }

function Kpi({ label, value, hint, sub, alert }: { label: string; value: string; hint?: string; sub?: string; alert?: boolean }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3.5" title={hint}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular">{value}</p>
      {sub && <p className={cn('mt-0.5 text-xs', alert ? 'font-medium text-danger' : 'text-muted')}>{sub}</p>}
    </div>
  )
}

export default function SalesDashboard() {
  const { t, formatNumber, formatDate } = useI18n()
  const { currentOrg, isOrgAdmin } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const { status } = useSalesStatus(orgId)
  const [period, setPeriod] = useState<Period>('d30')
  const [dash, setDash] = useState<Dash | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [due, setDue] = useState<Due[]>([])
  const [pending, setPending] = useState<Pending[]>([])
  const [work, setWork] = useState<Work[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [copilot, setCopilot] = useState(false)
  const money = useMoney('EUR')

  const load = useCallback(async () => {
    if (!supabase || !orgId) return
    setLoading(true)
    setError(false)
    const db = supabase
    const to = new Date(Date.now() + 60_000)
    const from = new Date(to.getTime() - DAYS[period] * 86_400_000)
    const endToday = new Date()
    endToday.setHours(23, 59, 59, 999)
    const [d, u, tasks, drafts, props, leads] = await Promise.all([
      db.rpc('sales_dashboard', { p_org: orgId, p_from: from.toISOString(), p_to: to.toISOString() }),
      db.rpc('usage_summary', { p_org: orgId }),
      db.from('follow_up_tasks').select('id, title, due_at, lead_id, lead:leads(company_name)').eq('organization_id', orgId).eq('status', 'open').lte('due_at', endToday.toISOString()).order('due_at').limit(8),
      db.from('message_drafts').select('id, channel, lead_id, created_at, lead:leads(company_name)').eq('organization_id', orgId).eq('status', 'draft').order('created_at', { ascending: false }).limit(6),
      db.from('sales_proposals').select('id, title, lead_id, created_at, lead:leads(company_name)').eq('organization_id', orgId).eq('status', 'draft').order('created_at', { ascending: false }).limit(6),
      db.from('leads').select('id, company_name, score, priority, status').eq('organization_id', orgId).is('deleted_at', null).not('status', 'in', '(won,lost,not_contactable)').order('score', { ascending: false, nullsFirst: false }).limit(6),
    ])
    if (d.error) {
      setError(true)
      setLoading(false)
      return
    }
    setDash(d.data as unknown as Dash)
    setUsage((u.data as unknown as Usage) ?? null)
    setDue((tasks.data ?? []) as unknown as Due[])
    const one = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x)
    setPending(
      [
        ...((drafts.data ?? []) as unknown as { id: string; channel: string; lead_id: string; created_at: string; lead: { company_name: string } | null }[]).map((r) => ({
          id: r.id, kind: 'draft' as const, label: t(`sales.messages.channels.${r.channel}`), lead_id: r.lead_id, company: one(r.lead)?.company_name ?? '', created_at: r.created_at,
        })),
        ...((props.data ?? []) as unknown as { id: string; title: string; lead_id: string; created_at: string; lead: { company_name: string } | null }[]).map((r) => ({
          id: r.id, kind: 'proposal' as const, label: r.title, lead_id: r.lead_id, company: one(r.lead)?.company_name ?? '', created_at: r.created_at,
        })),
      ]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 8),
    )
    setWork((leads.data ?? []) as Work[])
    setLoading(false)
  }, [orgId, period, t])

  useEffect(() => {
    void load()
  }, [load])

  const now = Date.now()
  return (
    <>
      <PageHeader
        title={t('sales.title')}
        subtitle={t('sales.subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/app/sales-agent/profile" className={buttonClasses('secondary', 'md')}>
              <Building2 className="size-4" aria-hidden />
              {t('sales.openProfile')}
            </Link>
            <Link to="/app/crm/pipeline" className={buttonClasses('secondary', 'md')}>
              <KanbanSquare className="size-4" aria-hidden />
              {t('sales.openPipeline')}
            </Link>
            <Button onClick={() => setCopilot(true)}>
              <Bot className="size-4" aria-hidden />
              {t('sales.openCopilot')}
            </Button>
          </div>
        }
      />
      <div className="space-y-5">
        {status && !status.profile.complete && (
          <InlineAlert tone="signal">
            {t('sales.banners.profileIncomplete')}{' '}
            <Link to="/app/sales-agent/profile" className="underline">
              {t('sales.banners.profileCta')}
            </Link>
          </InlineAlert>
        )}
        {status && !status.ai.configured && <InlineAlert tone="signal">{t('sales.banners.aiMissing')}</InlineAlert>}

        <div role="radiogroup" aria-label={t('sales.period.label')} className="inline-flex flex-wrap gap-1 rounded-[var(--radius-control)] border border-line p-1">
          {(Object.keys(DAYS) as Period[]).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={period === p} onClick={() => setPeriod(p)} className={cn('rounded-md px-3 py-1 text-sm', period === p ? 'bg-flow-soft font-medium text-flow' : 'text-muted hover:text-ink')}>
              {t(`sales.period.${p}`)}
            </button>
          ))}
        </div>

        {error ? (
          <ErrorState message={t('dashboard.loadError')} onRetry={() => void load()} className="rounded-[var(--radius-panel)] border border-line bg-surface" />
        ) : loading || !dash ? (
          <LoadingState />
        ) : (
          <>
            <section aria-label="KPI" className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label={t('sales.kpi.available')} value={formatNumber(dash.leads_available)} hint={t('sales.kpi.availableHint')} sub={t('sales.kpi.now')} />
              <Kpi label={t('sales.kpi.qualified')} value={formatNumber(dash.leads_qualified)} hint={t('sales.kpi.qualifiedHint')} sub={t('sales.kpi.now')} />
              <Kpi label={t('sales.kpi.proposals')} value={formatNumber(dash.proposals_generated)} sub={t('sales.kpi.inPeriod')} />
              <Kpi label={t('sales.kpi.drafts')} value={formatNumber(dash.drafts_pending)} sub={t('sales.kpi.now')} />
              <Kpi label={t('sales.kpi.followUps')} value={formatNumber(dash.follow_ups_due)} sub={dash.follow_ups_overdue ? t('sales.kpi.overdue', { count: dash.follow_ups_overdue }) : t('sales.kpi.now')} alert={dash.follow_ups_overdue > 0} />
              <Kpi label={t('sales.kpi.appointments')} value={formatNumber(dash.appointments_scheduled)} sub={t('sales.kpi.now')} />
              <Kpi label={t('sales.kpi.opportunities')} value={formatNumber(dash.opportunities_open)} sub={t('sales.kpi.opportunitiesValue', { value: money(Number(dash.opportunities_open_value)) })} />
              <Kpi label={t('sales.kpi.conversions')} value={formatNumber(dash.conversions)} hint={t('sales.kpi.conversionsHint')} sub={t('sales.kpi.inPeriod')} />
            </section>

            <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
              <Panel title={t('sales.charts.pipelineTitle')}>
                <BarList
                  title={t('sales.charts.pipelineTitle')}
                  rows={PIPELINE_STAGES.map((s) => ({ key: s, label: t(`status.${s}`), value: Number(dash.by_stage[s] ?? 0) }))}
                  highlight={(k) => (k === 'won' ? 'ok' : k === 'not_contactable' || k === 'lost' ? 'danger' : undefined)}
                />
              </Panel>
              <Panel title={t('sales.notifications.title')}>
                <div className="space-y-4">
                  {due.length === 0 ? (
                    <p className="text-sm text-muted">{t('sales.notifications.empty')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {due.map((d) => {
                        const overdue = new Date(d.due_at).getTime() < now
                        const lead = Array.isArray(d.lead) ? d.lead[0] : d.lead
                        return (
                          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                            <Link to={`/app/sales-agent/leads/${d.lead_id}?tab=followUps`} className="min-w-0 truncate hover:text-flow hover:underline">
                              <span className="font-medium">{lead?.company_name}</span> · {d.title}
                            </Link>
                            <Badge tone={overdue ? 'danger' : 'signal'}>{overdue ? t('sales.notifications.overdue') : t('sales.notifications.today')}</Badge>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  <div>
                    <h3 className="text-sm font-semibold">{t('sales.notifications.draftsTitle')}</h3>
                    {pending.length === 0 ? (
                      <p className="mt-1 text-sm text-muted">{t('sales.notifications.draftsEmpty')}</p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {pending.map((p) => (
                          <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                            <Link to={`/app/sales-agent/leads/${p.lead_id}?tab=${p.kind === 'proposal' ? 'proposals' : 'messages'}`} className="min-w-0 truncate hover:text-flow hover:underline">
                              <span className="font-medium">{p.company}</span> · {p.kind === 'proposal' ? `${t('sales.notifications.proposal')}: ${p.label}` : p.label}
                            </Link>
                            <span className="shrink-0 text-xs text-muted">{formatDate(p.created_at)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </Panel>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <Panel title={t('sales.charts.weeklyProposals')} className="lg:col-span-1">
                <ColumnChart title={t('sales.charts.weeklyProposals')} points={dash.weekly.map((w) => ({ label: formatDate(w.week), value: w.proposals }))} />
              </Panel>
              <Panel title={t('sales.charts.weeklyConversions')} className="lg:col-span-1">
                <ColumnChart title={t('sales.charts.weeklyConversions')} points={dash.weekly.map((w) => ({ label: formatDate(w.week), value: w.conversions }))} />
              </Panel>
              <Panel title={t('sales.usage.title')} className="lg:col-span-1">
                {usage ? (
                  <dl className="space-y-3 text-sm">
                    {(['ai_generations', 'ai_tokens'] as const).map((k) => {
                      const v = usage[k]
                      const ratio = v.limit ? Math.min(1, v.used / v.limit) : 0
                      return (
                        <div key={k}>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted">{k === 'ai_generations' ? t('sales.usage.generations') : t('sales.usage.tokens')}</dt>
                            <dd className="tabular font-medium">
                              {formatNumber(v.used)} / {formatNumber(v.limit)}
                            </dd>
                          </div>
                          <div className="mt-1 h-1.5 rounded-full bg-surface-2">
                            <div className={cn('h-full rounded-full', ratio >= 1 ? 'bg-danger' : ratio > 0.8 ? 'bg-signal' : 'bg-flow')} style={{ width: `${ratio * 100}%` }} />
                          </div>
                        </div>
                      )
                    })}
                    {isOrgAdmin && (
                      <div className="flex justify-between gap-2 border-t border-line pt-3">
                        <dt className="text-muted">{t('sales.usage.cost')}</dt>
                        <dd className="tabular font-medium">{status?.cost_tracking ? `$ ${Number(usage.ai_cost_usd ?? 0).toFixed(2)}` : '—'}</dd>
                      </div>
                    )}
                    {isOrgAdmin && status && !status.cost_tracking && <p className="text-xs text-muted">{t('sales.usage.costNotConfigured')}</p>}
                  </dl>
                ) : (
                  <LoadingState />
                )}
              </Panel>
            </div>

            <Panel title={t('sales.work.title')}>
              {work.length === 0 ? (
                <p className="text-sm text-muted">
                  {t('sales.work.empty')}{' '}
                  <Link to="/app/lead-finder" className="text-flow hover:underline">
                    {t('nav.leadFinder')}
                  </Link>
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {work.map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                      <Link to={`/app/sales-agent/leads/${w.id}`} className="min-w-0 truncate font-medium hover:text-flow hover:underline">
                        {w.company_name}
                      </Link>
                      <span className="flex items-center gap-2">
                        <Badge tone="neutral">{t(`status.${w.status}`)}</Badge>
                        {w.priority && <Badge tone={w.priority === 'high' ? 'ok' : w.priority === 'medium' ? 'signal' : 'neutral'}>{t(`leadFinder.priority.${w.priority}`)}</Badge>}
                        {w.score !== null && <span className="tabular w-8 text-right font-semibold">{w.score}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>
        )}
      </div>
      {copilot && <Copilot orgId={orgId} open onClose={() => setCopilot(false)} />}
    </>
  )
}
