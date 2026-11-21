import { useState } from 'react'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { Kpi } from '../../features/campaigns/shared'
import { Table, useApi, useFormatters } from '../../features/console/shared'

interface Overview {
  livemode: boolean
  currency: string
  mrr_cents: number
  reseller_mrr_cents: number
  active_subscriptions: number
  trialing_subscriptions: number
  cancellations: number
  active_at_window_start: number
  failed_payments: number
  net_collected_cents: number
  reseller_net_collected_cents: number
  ai_cost_usd: number
  provider_cost_usd: number
  organizations_total: number
  organizations_suspended: number
  new_organizations: number
  new_users: number
  paying_customers: number
  reseller_managed_organizations: number
  resellers_active: number
  resellers_total: number
  white_labels_active: number
  custom_domains_active: number
  reseller_wholesale_monthly_cents: number
  by_plan: { plan_code: string | null; count: number; mrr_cents: number }[]
  organizations: { id: string; name: string; plan_code: string | null; credits: number; tokens: number; ai_cost_usd: number; provider_cost_usd: number; net_collected_cents: number }[]
  operations: { ai_paused: boolean; providers_paused: string[] }
}

const WINDOWS = [30, 90, 365] as const

export default function SuperAdminOverview() {
  const { t } = useI18n()
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30)
  const { data: o, error, loading, reload } = useApi<Overview>(`/api/super-admin/overview?days=${days}`)
  const { money, usd, num } = useFormatters()
  if (loading && !o) return <LoadingState />
  if (error || !o) return <ErrorState message={t('console.loadError')} onRetry={() => void reload()} />

  const cur = o.currency
  const churn = o.active_at_window_start > 0 ? Math.round((o.cancellations / o.active_at_window_start) * 1000) / 10 : null
  const collected = o.net_collected_cents + o.reseller_net_collected_cents
  const costs = o.ai_cost_usd + o.provider_cost_usd
  const paused = [o.operations?.ai_paused ? 'AI' : null, ...(o.operations?.providers_paused ?? [])].filter(Boolean)

  return (
    <>
      <PageHeader title={t('saOverview.title')} subtitle={t('saOverview.subtitle')} />
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('saOverview.title')}>
          {WINDOWS.map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
              className={`rounded-full border px-3 py-1 text-xs ${days === d ? 'border-flow bg-flow-soft text-flow' : 'border-line text-muted hover:bg-surface-2'}`}>
              {t('console.days', { n: d })}
            </button>
          ))}
        </div>
        {!o.livemode && <InlineAlert tone="signal">{t('console.testData')}</InlineAlert>}
        {paused.length > 0 && <InlineAlert tone="signal">{t('saOverview.opsPaused', { list: paused.join(', ') })}</InlineAlert>}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label={t('saOverview.title')}>
          <Kpi label={t('saOverview.organizations')} value={num(o.organizations_total)} sub={o.organizations_suspended ? t('saOverview.suspended', { n: o.organizations_suspended }) : undefined} />
          <Kpi label={t('saOverview.paying')} value={num(o.paying_customers)} sub={t('saOverview.managed', { n: o.reseller_managed_organizations })} />
          <Kpi label={t('saOverview.activeSubs')} value={num(o.active_subscriptions)} />
          <Kpi label={t('saOverview.newOrgs')} value={num(o.new_organizations)} sub={t('saOverview.newUsers', { n: o.new_users })} />
          <Kpi label={t('saOverview.mrr')} value={money(o.mrr_cents, cur)} sub={t('saOverview.mrrReseller', { amount: money(o.reseller_mrr_cents, cur) })} />
          <Kpi label={t('saOverview.arr')} hint={t('saOverview.arrHint')} value={money((o.mrr_cents + o.reseller_mrr_cents) * 12, cur)} sub={t('saOverview.arrHint')} />
          <Kpi label={t('saOverview.churn')} value={churn === null ? '—' : `${churn}%`} sub={churn === null ? t('saOverview.churnNone') : `${o.cancellations}/${o.active_at_window_start}`} />
          <Kpi label={t('saOverview.failed')} value={num(o.failed_payments)} />
          <Kpi label={t('saOverview.collected')} value={money(collected, cur)} sub={t('saOverview.collectedReseller', { amount: money(o.reseller_net_collected_cents, cur) })} />
          <Kpi label={t('saOverview.aiCost')} value={usd(o.ai_cost_usd)} />
          <Kpi label={t('saOverview.providerCost')} value={usd(o.provider_cost_usd)} />
          <Kpi label={t('saOverview.margin')} hint={t('saOverview.marginHint')} value={`${money(collected, cur)} − ${usd(costs)}`} sub={t('saOverview.marginHint')} />
          <Kpi label={t('saOverview.resellers')} value={num(o.resellers_active)} sub={t('saOverview.resellersTotal', { n: o.resellers_total })} />
          <Kpi label={t('saOverview.whiteLabels')} value={num(o.white_labels_active)} sub={t('saOverview.domains', { n: o.custom_domains_active })} />
        </section>
        {o.reseller_wholesale_monthly_cents > 0 && <p className="text-sm text-muted">{t('saOverview.wholesale', { amount: money(o.reseller_wholesale_monthly_cents, cur) })}</p>}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Panel title={t('saOverview.byPlan')}>
            {o.by_plan.length === 0 ? <p className="text-sm text-muted">{t('console.none')}</p> : (
              <ul className="divide-y divide-line text-sm">
                {o.by_plan.map((p) => (
                  <li key={p.plan_code ?? 'none'} className="flex justify-between gap-3 py-1.5">
                    <span className="capitalize">{p.plan_code ?? '—'}</span>
                    <span className="tabular">{p.count} · {money(p.mrr_cents, cur)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={t('saOverview.topOrgs')}>
            {o.organizations.length === 0 ? <p className="text-sm text-muted">{t('console.none')}</p> : (
              <Table head={[t('saUsage.colOrg'), t('saUsage.colPlan'), t('saUsage.credits'), t('saUsage.aiCost'), t('saUsage.providerCost'), t('saUsage.colCollected')]}>
                {o.organizations.slice(0, 20).map((r) => (
                  <tr key={r.id}>
                    <td className="max-w-[200px] truncate py-2 pr-3">{r.name}</td>
                    <td className="py-2 pr-3 capitalize">{r.plan_code ?? '—'}</td>
                    <td className="tabular py-2 pr-3">{num(r.credits)}</td>
                    <td className="tabular py-2 pr-3">{usd(r.ai_cost_usd)}</td>
                    <td className="tabular py-2 pr-3">{usd(r.provider_cost_usd)}</td>
                    <td className="tabular py-2">{money(r.net_collected_cents, cur)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}
