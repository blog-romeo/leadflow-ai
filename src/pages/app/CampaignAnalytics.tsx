import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { ErrorState, LoadingState } from '../../components/ui/States'
import { ColumnChart } from '../../features/sales/Charts'
import { useMoney } from '../../features/sales/ProposalBuilder'
import { Kpi } from '../../features/campaigns/shared'
import { CampaignFilters, useCampaignFilters, useMetrics, type Metrics } from './Campaigns'

function Rate({ name, r }: { name: keyof Metrics['rates']; r: Metrics['rates'][keyof Metrics['rates']] }) {
  const { t, formatNumber } = useI18n()
  return (
    <div className="min-w-0 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3.5">
      <p className="text-xs text-muted">{t(`analytics.rates.${name}`)}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular">{r.value == null ? '—' : `${formatNumber(r.value)}%`}</p>
      <p className="mt-0.5 text-xs text-muted">
        {r.denominator > 0
          ? t('analytics.rates.formula', { num: formatNumber(r.numerator), den: formatNumber(r.denominator), label: t(`analytics.rates.labels.${r.denominator_label}`) })
          : t('analytics.rates.noDenominator')}
      </p>
    </div>
  )
}

function Revenue({ rows }: { rows: Metrics['revenue'] }) {
  const { t } = useI18n()
  const fmt = useMoney(rows[0]?.currency ?? 'EUR')
  if (!rows.length) return <p className="text-sm text-muted">{t('analytics.metrics.revenueNone')}</p>
  return (
    <ul className="space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.currency} className="flex justify-between gap-3">
          <span>{r.currency}</span>
          <span className="tabular font-semibold">{fmt(r.amount)}</span>
        </li>
      ))}
    </ul>
  )
}

export default function CampaignAnalytics() {
  const { t, formatNumber, formatDate } = useI18n()
  const { currentOrg } = useAuth()
  const f = useCampaignFilters()
  const { metrics: m, campaigns, error, loading, reload } = useMetrics(currentOrg?.id ?? '', f)
  const n = (v: number | undefined) => formatNumber(v ?? 0)

  return (
    <>
      <PageHeader title={t('analytics.title')} subtitle={t('analytics.subtitle')} />
      <div className="space-y-5">
        <CampaignFilters f={f} campaigns={campaigns} />
        {loading && !m ? (
          <LoadingState />
        ) : error || !m ? (
          <ErrorState message={t('cm.errors.generic')} onRetry={() => void reload()} />
        ) : (
          <>
            <section aria-label={t('analytics.title')} className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Rate name="reply_rate" r={m.rates.reply_rate} />
              <Rate name="appointment_rate" r={m.rates.appointment_rate} />
              <Rate name="conversion_rate" r={m.rates.conversion_rate} />
              <Rate name="bounce_rate" r={m.rates.bounce_rate} />
            </section>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Kpi label={t('analytics.metrics.eligible')} value={n(m.totals.eligible)} />
              <Kpi label={t('analytics.metrics.sent')} value={n(m.totals.sent)} />
              <Kpi label={t('analytics.metrics.delivered')} value={n(m.totals.delivered)} />
              <Kpi label={t('analytics.metrics.bounced')} value={n(m.totals.bounced)} sub={`${t('analytics.metrics.complaints')}: ${n(m.totals.complaints)}`} />
              <Kpi label={t('analytics.metrics.replies')} value={n(m.totals.replies)} />
              <Kpi
                label={t('analytics.metrics.positive')}
                value={n(m.totals.positive_confirmed)}
                sub={m.totals.positive_ai_unconfirmed ? t('analytics.metrics.positiveAi', { n: m.totals.positive_ai_unconfirmed }) : undefined}
              />
              <Kpi label={t('analytics.metrics.contacted')} value={n(m.totals.contacted)} />
              <Kpi label={t('analytics.metrics.appointments')} value={n(m.totals.appointments)} />
              <Kpi label={t('analytics.metrics.opportunities')} value={n(m.totals.opportunities)} />
              <Kpi label={t('analytics.metrics.customers')} value={n(m.totals.customers)} />
            </section>
            <div className="space-y-1 text-xs text-muted">
              <p>{t('analytics.opensNote')}</p>
              <p>{t('analytics.attribution')} {t('analytics.testsNote')}</p>
            </div>
            <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
              <Panel title={t('analytics.weekly')}>
                <ColumnChart title={t('analytics.weekly')} points={m.weekly_sent.map((w) => ({ label: formatDate(w.week), value: w.sent }))} />
              </Panel>
              <Panel title={t('analytics.metrics.revenue')}>
                <Revenue rows={m.revenue} />
              </Panel>
            </div>
            <Panel title={t('analytics.byCampaign')}>
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <caption className="sr-only">{t('analytics.byCampaign')}</caption>
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th scope="col" className="px-5 py-2 font-medium">{t('cm.list.name')}</th>
                      {(['eligible', 'sent', 'delivered', 'bounced', 'replies', 'appointments', 'opportunities', 'customers'] as const).map((k) => (
                        <th key={k} scope="col" className="px-3 py-2 text-right font-medium">
                          {t(`analytics.metrics.${k}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {m.by_campaign.map((c) => (
                      <tr key={c.id} className="border-b border-line/70 last:border-0">
                        <td className="px-5 py-2">{c.name}</td>
                        {(['eligible', 'sent', 'delivered', 'bounced', 'replies', 'appointments', 'opportunities', 'customers'] as const).map((k) => (
                          <td key={k} className="px-3 py-2 text-right tabular">
                            {n(c[k])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}
      </div>
    </>
  )
}
