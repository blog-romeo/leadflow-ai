import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ErrorState, LoadingState } from '../../components/ui/States'
import { Kpi } from '../../features/campaigns/shared'
import { Table, useApi, useFormatters } from '../../features/console/shared'

interface System {
  webhooks: { processed_24h: number; failed_24h: number; stuck: number; last_processed_at: string | null }
  ai_jobs: { queued: number; running: number; stuck: number; failed_24h: number; succeeded_24h: number }
  automation_jobs: { failed_24h: number; pending: number }
  errors: { function_24h: number; client_24h: number; top: { source: string; code: string; path: string | null; occurrences: number; last_seen: string }[] }
  ai_cost: { month_usd: number; budget_usd: number | null; threshold_pct: number }
  support: { open: number; urgent: number }
  demo_requests_new: number
  alerts: { id: number; kind: string; severity: 'info' | 'warning' | 'critical'; message: string; created_at: string; notified_at: string | null; notify_error: string | null }[]
  integrations: { key: string; state: 'configured' | 'partial' | 'missing'; note?: string }[]
  release: string | null
}
const STATE_TONE = { configured: 'ok', partial: 'signal', missing: 'danger' } as const
const SEV_TONE = { info: 'neutral', warning: 'signal', critical: 'danger' } as const

export default function SuperAdminSystem() {
  const { t, formatDate } = useI18n()
  const { num, usd } = useFormatters()
  const { data, error, loading, reload } = useApi<System>('/api/super-admin/system')
  return (
    <>
      <PageHeader title={t('system.title')} subtitle={data?.release ? `${t('system.release')}: ${data.release}` : undefined} actions={<Button size="sm" variant="secondary" onClick={() => void reload()}>{t('common.retry')}</Button>} />
      {error ? (
        <ErrorState message={t('support.errors.generic')} onRetry={() => void reload()} />
      ) : loading || !data ? (
        <LoadingState />
      ) : (
        <div className="space-y-6">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={`${t('system.webhooks')} · ${t('system.failed24')}`} value={num(data.webhooks.failed_24h)} sub={`${t('system.stuck')}: ${num(data.webhooks.stuck)}`} />
            <Kpi label={t('system.functionErrors')} value={num(data.errors.function_24h)} sub={`${t('system.clientErrors')}: ${num(data.errors.client_24h)}`} />
            <Kpi label={t('system.aiCost')} value={usd(data.ai_cost.month_usd)} sub={data.ai_cost.budget_usd !== null ? `${t('system.budget')}: ${usd(data.ai_cost.budget_usd)}` : undefined} />
            <Kpi label={t('system.support')} value={num(data.support.open)} sub={`${num(data.support.urgent)} ${t('system.urgent')} · ${t('system.demoNew')}: ${num(data.demo_requests_new)}`} />
          </section>

          <Panel title={t('system.alerts')}>
            {data.alerts.length === 0 ? (
              <p className="text-sm text-muted">{t('system.noAlerts')}</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {data.alerts.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                    <Badge tone={SEV_TONE[a.severity]}>{a.severity}</Badge>
                    <span className="flex-1">{a.message}</span>
                    <span className="text-xs text-muted">{a.notified_at ? t('system.notified') : `${t('system.notNotified')}${a.notify_error ? ` (${a.notify_error})` : ''}`}</span>
                    <time className="text-xs text-muted" dateTime={a.created_at}>{formatDate(a.created_at)}</time>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title={t('system.integrations')}>
              <ul className="divide-y divide-line text-sm">
                {data.integrations.map((i) => (
                  <li key={i.key} className="flex items-center justify-between gap-3 py-2">
                    <span>
                      {t(`system.names.${i.key}`)}
                      {i.note && t(`system.notes.${i.note}`) && <span className="block text-xs text-muted">{t(`system.notes.${i.note}`)}</span>}
                    </span>
                    <Badge tone={STATE_TONE[i.state]}>{t(`system.states.${i.state}`)}</Badge>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted">{t('system.integrationsNote')}</p>
            </Panel>
            <Panel title={`${t('system.aiJobs')} · ${t('system.webhooks')} · ${t('system.automation')}`}>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {[
                  [`${t('system.aiJobs')} · ${t('system.queued')}`, data.ai_jobs.queued],
                  [`${t('system.aiJobs')} · ${t('system.running')}`, data.ai_jobs.running],
                  [`${t('system.aiJobs')} · ${t('system.stuck')}`, data.ai_jobs.stuck],
                  [`${t('system.aiJobs')} · ${t('system.failed24')}`, data.ai_jobs.failed_24h],
                  [`${t('system.aiJobs')} · ${t('system.succeeded24')}`, data.ai_jobs.succeeded_24h],
                  [`${t('system.webhooks')} · ${t('system.processed24')}`, data.webhooks.processed_24h],
                  [`${t('system.automation')} · ${t('system.failed24')}`, data.automation_jobs.failed_24h],
                  [`${t('system.automation')} · ${t('system.pending')}`, data.automation_jobs.pending],
                ].map(([k, v]) => (
                  <div key={k as string} className="flex justify-between gap-2 border-b border-line py-1">
                    <dt className="text-muted">{k}</dt>
                    <dd className="tabular">{num(v as number)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-xs text-muted">
                {t('system.lastProcessed')}: {data.webhooks.last_processed_at ? formatDate(data.webhooks.last_processed_at) : '—'}
              </p>
            </Panel>
          </div>

          <Panel title={t('system.topErrors')}>
            {data.errors.top.length === 0 ? (
              <p className="text-sm text-muted">—</p>
            ) : (
              <Table head={['source', 'code', 'path', t('system.occurrences'), '']}>
                {data.errors.top.map((e, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="py-2">{e.source}</td>
                    <td className="font-mono text-xs">{e.code}</td>
                    <td className="font-mono text-xs">{e.path ?? '—'}</td>
                    <td className="tabular">{num(e.occurrences)}</td>
                    <td className="text-xs text-muted">{formatDate(e.last_seen)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>
      )}
    </>
  )
}
