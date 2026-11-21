import { useMemo, useState } from 'react'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Button } from '../../components/ui/Button'
import { ErrorState, LoadingState } from '../../components/ui/States'
import { Kpi } from '../../features/campaigns/shared'
import { ColumnChart } from '../../features/sales/Charts'
import { useApi, useFormatters } from '../../features/console/shared'

interface Growth {
  events: Record<string, number>
  visitors_consented: number
  pricing_viewers: number
  signups: number
  onboarding_started: number
  onboarding_completed: number
  onboarding_abandoned: number
  cohort_organizations: number
  cohort_paid: number
  cohort_activated: number
  cohort_ai: number
  demo_requests: number
  paying_customers: number
  mrr: number | null
  daily: { day: string; visits: number; signups: number }[]
}
const PRESETS = [7, 30, 90] as const

export default function SuperAdminGrowth() {
  const { t, formatDate } = useI18n()
  const { money, num } = useFormatters()
  const [days, setDays] = useState<number>(30)
  const range = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - days * 86_400_000)
    return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
  }, [days])
  const { data, error, loading, reload } = useApi<Growth>(`/api/super-admin/growth?${range}`)
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : '—')

  return (
    <>
      <PageHeader
        title={t('growth.title')}
        actions={
          <div className="flex gap-1" role="group" aria-label={t('growth.period')}>
            {PRESETS.map((d) => (
              <Button key={d} size="sm" variant={d === days ? 'primary' : 'secondary'} onClick={() => setDays(d)} aria-pressed={d === days}>
                {t('growth.days', { n: d })}
              </Button>
            ))}
          </div>
        }
      />
      {error ? (
        <ErrorState message={t('support.errors.generic')} onRetry={() => void reload()} />
      ) : loading || !data ? (
        <LoadingState />
      ) : (
        <div className="space-y-6">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={t('growth.visitors')} value={num(data.visitors_consented)} sub={t('growth.visitorsNote')} />
            <Kpi label={t('growth.signups')} value={num(data.signups)} />
            <Kpi label={t('growth.payingCustomers')} value={num(data.paying_customers)} />
            <Kpi label={t('growth.mrr')} value={money(Number(data.mrr ?? 0))} />
          </section>
          <Panel title={t('growth.funnel')}>
            <ol className="grid gap-px overflow-hidden rounded-[var(--radius-control)] border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
              {[
                [t('growth.visitors'), data.visitors_consented],
                [t('growth.pricingViewers'), data.pricing_viewers],
                [t('growth.signups'), data.signups],
                [t('growth.onboardingCompleted'), data.onboarding_completed],
                [t('growth.activated'), data.cohort_activated],
                [t('growth.paid'), data.cohort_paid],
              ].map(([label, n]) => (
                <li key={label as string} className="bg-surface px-4 py-3">
                  <p className="text-xs text-muted">{label}</p>
                  <p className="mt-0.5 font-display text-xl font-semibold tabular">{num(n as number)}</p>
                </li>
              ))}
            </ol>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-muted">{t('growth.conversion')}</dt><dd className="font-semibold tabular">{pct(data.cohort_paid, data.cohort_organizations)}</dd></div>
              <div><dt className="text-muted">{t('growth.onboardingAbandoned')}</dt><dd className="font-semibold tabular">{num(data.onboarding_abandoned)} / {num(data.onboarding_started)}</dd></div>
              <div><dt className="text-muted">{t('growth.aiUsed')}</dt><dd className="font-semibold tabular">{num(data.cohort_ai)}</dd></div>
              <div><dt className="text-muted">{t('growth.demoRequests')}</dt><dd className="font-semibold tabular">{num(data.demo_requests)}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-muted">{t('growth.cohortNote')}</p>
          </Panel>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title={`${t('growth.daily')} · ${t('growth.visits')}`}>
              <ColumnChart title={t('growth.visits')} points={data.daily.map((d) => ({ label: formatDate(d.day), value: d.visits }))} />
            </Panel>
            <Panel title={`${t('growth.daily')} · ${t('growth.signups')}`}>
              <ColumnChart title={t('growth.signups')} points={data.daily.map((d) => ({ label: formatDate(d.day), value: d.signups }))} />
            </Panel>
          </div>
          <Panel title={t('growth.events')}>
            {Object.keys(data.events).length === 0 ? (
              <p className="text-sm text-muted">{t('growth.noData')}</p>
            ) : (
              <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(data.events).map(([k, n]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-line py-1">
                    <dt className="font-mono text-xs">{k}</dt>
                    <dd className="tabular">{num(n)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>
        </div>
      )}
    </>
  )
}
