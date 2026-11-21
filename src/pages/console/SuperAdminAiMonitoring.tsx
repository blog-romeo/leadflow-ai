import { useMemo, useState } from 'react'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ErrorState, LoadingState } from '../../components/ui/States'
import { Kpi } from '../../features/campaigns/shared'
import { Table, inputCls, useApi, useFormatters } from '../../features/console/shared'

/**
 * /super-admin/ai-monitoring — osservabilità del motore multi-agent (Prompt 9).
 * Solo aggregati calcolati dal database (sa_ai_monitoring): nessun obiettivo, output o nome di azienda
 * dei clienti. "Configurato" indica la presenza delle variabili, non il funzionamento del servizio.
 */
const AGENTS = ['orchestrator', 'discovery', 'research', 'scoring', 'strategy', 'follow_up', 'growth_analyst'] as const
const STATUSES = ['pending', 'running', 'waiting_approval', 'completed', 'partial', 'failed', 'cancelled'] as const

interface AgentRow { agent_key: string; runs: number; running_now: number; succeeded: number; partial: number; failed: number; error_rate: number | null; avg_ms: number | null; p95_ms: number | null; tokens_input: number; tokens_output: number; credits: number; cost_usd: number; unpriced_runs: number }
interface QualityRow { agent_key: string; envelopes: number; valid_output_rate: number | null; evidence_required: number; evidence_coverage: number | null; facts: number; inferences: number; unknowns: number; item_failure_rate: number | null; model_fallbacks: number }
interface Monitoring {
  workflows: { total: number; by_status: Record<string, number>; by_template: Record<string, number>; active_now: number; waiting_approval_now: number; avg_duration_ms: number | null; avg_start_latency_ms: number | null; credits_used: number; cost_usd: number; cost_per_completed_workflow_usd: number | null }
  agents: AgentRow[]
  quality: QualityRow[]
  unsupported_claims: number
  errors: { code: string; agent_key: string; count: number }[]
  costs: { ai_calls: number; provider_calls: number; cache_hits: number; tokens_input: number; tokens_output: number; credits: number; cost_usd: number; unpriced_calls: number }
  daily: { day: string; workflows: number; completed: number; failed: number; credits: number }[]
  organizations: { organization_id: string; name: string; workflows: number; failed: number; credits: number; cost_usd: number }[]
  providers: { key: string; state: 'configured' | 'partial' | 'missing'; note?: string }[]
  routing: { task: string; requested: string; effective: string; configured: boolean; model: string | null; fallback: boolean }[]
  engine_enabled: boolean
  pilot_orgs: number | null
}

const STATE_TONE = { configured: 'ok', partial: 'signal', missing: 'danger' } as const
const iso = (d: Date) => d.toISOString().slice(0, 10)
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`)

export default function SuperAdminAiMonitoring() {
  const { t } = useI18n()
  const { num, usd } = useFormatters()
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)))
  const [to, setTo] = useState(iso(new Date()))
  const [org, setOrg] = useState('')
  const [agent, setAgent] = useState('')
  const [status, setStatus] = useState('')
  const path = useMemo(() => {
    const q = new URLSearchParams({ from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T23:59:59Z`).toISOString() })
    if (/^[0-9a-f-]{36}$/i.test(org.trim())) q.set('organization_id', org.trim())
    if (agent) q.set('agent', agent)
    if (status) q.set('status', status)
    return `/api/super-admin/ai-monitoring?${q.toString()}`
  }, [from, to, org, agent, status])
  const { data, error, loading, reload } = useApi<Monitoring>(path)
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1000 ? `${num(Math.round(v / 100) / 10)} s` : `${num(v)} ms`)

  return (
    <>
      <PageHeader title={t('aiMonitoring.title')} subtitle={t('aiMonitoring.subtitle')} actions={<Button size="sm" variant="secondary" onClick={() => void reload()}>{t('common.retry')}</Button>} />
      <Panel title={t('aiMonitoring.filters')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block text-sm">{t('aiMonitoring.from')}<input className={inputCls} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="block text-sm">{t('aiMonitoring.to')}<input className={inputCls} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="block text-sm">{t('aiMonitoring.organization')}<input className={inputCls} value={org} placeholder="UUID" onChange={(e) => setOrg(e.target.value)} /></label>
          <label className="block text-sm">
            {t('aiMonitoring.agent')}
            <select className={inputCls} value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">{t('aiMonitoring.all')}</option>
              {AGENTS.map((a) => <option key={a} value={a}>{t(`aiAgents.agents.${a}.name`)}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            {t('aiMonitoring.status')}
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('aiMonitoring.all')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`aiWorkflows.status.${s}`)}</option>)}
            </select>
          </label>
        </div>
      </Panel>
      {error ? (
        <div className="mt-6"><ErrorState message={t('support.errors.generic')} onRetry={() => void reload()} /></div>
      ) : loading || !data ? (
        <LoadingState />
      ) : (
        <div className="mt-6 space-y-6">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={data.engine_enabled ? 'ok' : 'neutral'}>{data.engine_enabled ? t('aiMonitoring.engineOn') : t('aiMonitoring.engineOff')}</Badge>
            {data.pilot_orgs !== null && <Badge tone="signal">{t('aiMonitoring.pilot', { n: data.pilot_orgs })}</Badge>}
          </div>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={t('aiMonitoring.kpi.workflows')} value={num(data.workflows.total)} sub={`${t('aiMonitoring.kpi.completed')}: ${num(data.workflows.by_status.completed ?? 0)} · ${t('aiMonitoring.kpi.failed')}: ${num(data.workflows.by_status.failed ?? 0)}`} />
            <Kpi label={t('aiMonitoring.kpi.active')} value={num(data.workflows.active_now)} sub={`${t('aiMonitoring.kpi.waiting')}: ${num(data.workflows.waiting_approval_now)}`} />
            <Kpi label={t('aiMonitoring.kpi.duration')} value={ms(data.workflows.avg_duration_ms)} sub={`${t('aiMonitoring.kpi.startLatency')}: ${ms(data.workflows.avg_start_latency_ms)}`} />
            <Kpi label={t('aiMonitoring.kpi.credits')} value={num(data.workflows.credits_used)} sub={`${usd(data.costs.cost_usd)}${data.costs.unpriced_calls ? ` · ${t('aiMonitoring.kpi.unpriced', { n: data.costs.unpriced_calls })}` : ''}`} />
          </section>

          <Panel title={t('aiMonitoring.agents')}>
            <Table head={[t('aiMonitoring.cols.agent'), t('aiMonitoring.cols.runs'), t('aiMonitoring.cols.running'), t('aiMonitoring.cols.failed'), t('aiMonitoring.cols.errorRate'), t('aiMonitoring.cols.avg'), 'p95', t('aiMonitoring.cols.tokens'), t('aiMonitoring.cols.credits'), t('aiMonitoring.cols.cost')]} minWidth={860}>
              {data.agents.map((a) => (
                <tr key={a.agent_key} className="border-t border-line">
                  <td className="py-2 pr-3">{t(`aiAgents.agents.${a.agent_key}.name`)}</td>
                  <td className="tabular pr-3">{num(a.runs)}</td>
                  <td className="tabular pr-3">{num(a.running_now)}</td>
                  <td className="tabular pr-3">{num(a.failed)}</td>
                  <td className="tabular pr-3">{pct(a.error_rate)}</td>
                  <td className="tabular pr-3">{ms(a.avg_ms)}</td>
                  <td className="tabular pr-3">{ms(a.p95_ms)}</td>
                  <td className="tabular pr-3">{num(a.tokens_input + a.tokens_output)}</td>
                  <td className="tabular pr-3">{num(a.credits)}</td>
                  <td className="tabular">{a.unpriced_runs > 0 ? `${usd(a.cost_usd)} *` : usd(a.cost_usd)}</td>
                </tr>
              ))}
            </Table>
            {data.agents.length === 0 && <p className="text-sm text-muted">{t('aiMonitoring.empty')}</p>}
            <p className="mt-3 text-xs text-muted">{t('aiMonitoring.costNote')}</p>
          </Panel>

          <Panel title={t('aiMonitoring.quality')}>
            <Table head={[t('aiMonitoring.cols.agent'), t('aiMonitoring.cols.envelopes'), t('aiMonitoring.cols.validJson'), t('aiMonitoring.cols.evidence'), 'FACT / INF / UNK', t('aiMonitoring.cols.itemFailures'), t('aiMonitoring.cols.fallbacks')]} minWidth={760}>
              {data.quality.map((q) => (
                <tr key={q.agent_key} className="border-t border-line">
                  <td className="py-2 pr-3">{t(`aiAgents.agents.${q.agent_key}.name`)}</td>
                  <td className="tabular pr-3">{num(q.envelopes)}</td>
                  <td className="tabular pr-3">{pct(q.valid_output_rate)}</td>
                  <td className="tabular pr-3">{q.evidence_required ? pct(q.evidence_coverage) : '—'}</td>
                  <td className="tabular pr-3">{`${num(q.facts)} / ${num(q.inferences)} / ${num(q.unknowns)}`}</td>
                  <td className="tabular pr-3">{pct(q.item_failure_rate)}</td>
                  <td className="tabular">{num(q.model_fallbacks)}</td>
                </tr>
              ))}
            </Table>
            {data.quality.length === 0 && <p className="text-sm text-muted">{t('aiMonitoring.noEnvelopes')}</p>}
            <p className="mt-3 text-xs text-muted">{t('aiMonitoring.qualityNote', { n: data.unsupported_claims })}</p>
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title={t('aiMonitoring.providers')}>
              <ul className="divide-y divide-line text-sm">
                {data.providers.map((p) => (
                  <li key={p.key} className="flex items-center justify-between gap-3 py-2">
                    <span>{t(`system.names.${p.key}`)}</span>
                    <Badge tone={STATE_TONE[p.state]}>{t(`system.states.${p.state}`)}</Badge>
                  </li>
                ))}
              </ul>
              <h3 className="mt-4 text-xs font-medium text-muted">{t('aiMonitoring.routing')}</h3>
              <ul className="mt-1 divide-y divide-line text-sm">
                {data.routing.map((r) => (
                  <li key={r.task} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{t(`aiMonitoring.tasks.${r.task}`)}</span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className="text-muted">{t(`aiAgents.tiers.${r.effective}`)}{r.model ? ` · ${r.model}` : ''}</span>
                      {r.fallback && <Badge tone="signal">{t('aiMonitoring.fallback')}</Badge>}
                      <Badge tone={r.configured ? 'ok' : 'danger'}>{r.configured ? t('system.states.configured') : t('system.states.missing')}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted">{t('system.integrationsNote')}</p>
            </Panel>
            <Panel title={t('aiMonitoring.errors')}>
              {data.errors.length === 0 ? (
                <p className="text-sm text-muted">—</p>
              ) : (
                <Table head={[t('aiMonitoring.cols.code'), t('aiMonitoring.cols.agent'), t('aiMonitoring.cols.count')]} minWidth={360}>
                  {data.errors.map((e) => (
                    <tr key={`${e.code}-${e.agent_key}`} className="border-t border-line">
                      <td className="py-2 pr-3 font-mono text-xs">{e.code}</td>
                      <td className="pr-3">{t(`aiAgents.agents.${e.agent_key}.name`)}</td>
                      <td className="tabular">{num(e.count)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Panel>
          </div>

          <Panel title={t('aiMonitoring.organizations')}>
            {data.organizations.length === 0 ? (
              <p className="text-sm text-muted">{t('aiMonitoring.empty')}</p>
            ) : (
              <Table head={[t('aiMonitoring.organization'), t('aiMonitoring.kpi.workflows'), t('aiMonitoring.kpi.failed'), t('aiMonitoring.cols.credits'), t('aiMonitoring.cols.cost')]} minWidth={520}>
                {data.organizations.map((o) => (
                  <tr key={o.organization_id} className="border-t border-line">
                    <td className="py-2 pr-3">
                      <button type="button" className="text-left hover:text-flow hover:underline" onClick={() => setOrg(o.organization_id)}>{o.name}</button>
                    </td>
                    <td className="tabular pr-3">{num(o.workflows)}</td>
                    <td className="tabular pr-3">{num(o.failed)}</td>
                    <td className="tabular pr-3">{num(o.credits)}</td>
                    <td className="tabular">{usd(o.cost_usd)}</td>
                  </tr>
                ))}
              </Table>
            )}
            <p className="mt-3 text-xs text-muted">{t('aiMonitoring.privacyNote')}</p>
          </Panel>
        </div>
      )}
    </>
  )
}
