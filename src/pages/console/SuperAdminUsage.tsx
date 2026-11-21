import { useState } from 'react'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Button } from '../../components/ui/Button'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { Kpi } from '../../features/campaigns/shared'
import { ColumnChart } from '../../features/sales/Charts'
import { ReasonDialog, Table, inputCls, post, useApi, useFormatters } from '../../features/console/shared'

interface CostControls { monthly_ai_budget_usd: number | null; alert_threshold_pct: number; hard_stop_at_budget: boolean; default_org_monthly_ai_cap_usd: number | null }
interface Operations { ai_paused: boolean; providers_paused: string[] }
interface Usage {
  tokens: { input: number; output: number }
  ai_requests: { total: number; succeeded: number; failed: number; without_cost: number }
  ai_cost_usd: number
  by_model: { model: string; requests: number; failed: number; tokens_input: number; tokens_output: number; cost_usd: number; without_cost: number }[]
  providers: { provider: string; requests: number; cost_usd: number; without_cost: number }[]
  provider_cost_usd: number
  credits_used: number
  leads_acquired: number
  daily: { day: string; tokens: number; ai_cost_usd: number; provider_cost_usd: number; requests: number; failed: number }[]
  organizations: { id: string; name: string; plan_code: string | null; tokens: number; ai_cost_usd: number; provider_cost_usd: number; failed_jobs: number; credits: number; leads: number; net_collected_cents: number; month_ai_cost_usd: number; cap_usd: number | null }[]
  by_plan: { plan_code: string; organizations: number; net_collected_cents: number; ai_cost_usd: number; provider_cost_usd: number; credits: number }[]
  alerts: { type: string; level: 'info' | 'warning' | 'critical'; spent_usd?: number; budget_usd?: number; cap_usd?: number; organization?: string; failed?: number; total?: number; jobs?: number }[]
  cost_controls: CostControls
  operations: Operations
}

const PRESETS = [7, 30, 90] as const
const PROVIDERS = ['osm_overpass', 'google_places'] as const
const iso = (d: Date) => d.toISOString().slice(0, 10)

function Controls({ cc, ops, onSaved }: { cc: CostControls; ops: Operations; onSaved: () => void }) {
  const { t } = useI18n()
  const [budget, setBudget] = useState(cc.monthly_ai_budget_usd?.toString() ?? '')
  const [threshold, setThreshold] = useState(String(cc.alert_threshold_pct ?? 80))
  const [hardStop, setHardStop] = useState(cc.hard_stop_at_budget)
  const [defCap, setDefCap] = useState(cc.default_org_monthly_ai_cap_usd?.toString() ?? '')
  const [aiPaused, setAiPaused] = useState(ops.ai_paused)
  const [paused, setPaused] = useState<string[]>(ops.providers_paused ?? [])
  const [dialog, setDialog] = useState<'cost' | 'ops' | null>(null)
  const n = (v: string) => (v.trim() === '' ? null : Math.max(0, Number(v)))
  return (
    <Panel title={t('saUsage.controls')}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 text-sm">
          <label className="block">{t('saUsage.budget')}<input className={inputCls} type="number" min={0} value={budget} placeholder={t('saUsage.emptyMeansNone')} onChange={(e) => setBudget(e.target.value)} /></label>
          <label className="block">{t('saUsage.threshold')}<input className={inputCls} type="number" min={1} max={100} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
          <label className="block">{t('saUsage.defaultCap')}<input className={inputCls} type="number" min={0} value={defCap} placeholder={t('saUsage.emptyMeansNone')} onChange={(e) => setDefCap(e.target.value)} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={hardStop} onChange={(e) => setHardStop(e.target.checked)} />{t('saUsage.hardStop')}</label>
          <Button size="sm" onClick={() => setDialog('cost')}>{t('saUsage.saveControls')}</Button>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={aiPaused} onChange={(e) => setAiPaused(e.target.checked)} />{t('saUsage.pauseAi')}</label>
          <fieldset>
            <legend>{t('saUsage.pauseProviders')}</legend>
            {PROVIDERS.map((p) => (
              <label key={p} className="flex items-center gap-2">
                <input type="checkbox" checked={paused.includes(p)} onChange={(e) => setPaused(e.target.checked ? [...paused, p] : paused.filter((x) => x !== p))} />
                <span className="font-mono text-xs">{p}</span>
              </label>
            ))}
          </fieldset>
          <Button size="sm" variant={aiPaused || paused.length ? 'danger' : 'secondary'} onClick={() => setDialog('ops')}>{t('saUsage.saveOps')}</Button>
        </div>
      </div>
      <ReasonDialog
        open={dialog !== null}
        danger={dialog === 'ops'}
        title={dialog === 'ops' ? t('saUsage.saveOps') : t('saUsage.saveControls')}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          if (dialog === 'cost') {
            await post('/api/super-admin/setting', { key: 'cost_controls', reason, value: { monthly_ai_budget_usd: n(budget), alert_threshold_pct: Math.min(100, Math.max(1, Number(threshold) || 80)), hard_stop_at_budget: hardStop, default_org_monthly_ai_cap_usd: n(defCap) } })
          } else {
            await post('/api/super-admin/setting', { key: 'operations', reason, value: { ai_paused: aiPaused, providers_paused: paused } })
          }
          onSaved()
        }}
      />
    </Panel>
  )
}

export default function SuperAdminUsage() {
  const { t, formatDate } = useI18n()
  const { money, usd, num } = useFormatters()
  const [range, setRange] = useState(() => ({ from: iso(new Date(Date.now() - 30 * 86_400_000)), to: iso(new Date(Date.now() + 86_400_000)) }))
  const [draft, setDraft] = useState(range)
  const { data: u, error, loading, reload } = useApi<Usage>(`/api/super-admin/usage?from=${range.from}&to=${range.to}`)

  const preset = (d: number) => {
    const r = { from: iso(new Date(Date.now() - d * 86_400_000)), to: iso(new Date(Date.now() + 86_400_000)) }
    setRange(r)
    setDraft(r)
  }

  return (
    <>
      <PageHeader title={t('saUsage.title')} subtitle={t('saUsage.subtitle')} />
      <div className="mb-4 flex flex-wrap items-end gap-2 text-sm">
        {PRESETS.map((d) => <Button key={d} size="sm" variant="ghost" onClick={() => preset(d)}>{t('console.days', { n: d })}</Button>)}
        <label>{t('console.from')}<input className={inputCls} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
        <label>{t('console.to')}<input className={inputCls} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
        <Button size="sm" variant="secondary" onClick={() => setRange(draft)}>{t('console.apply')}</Button>
      </div>
      {loading && !u ? <LoadingState /> : error || !u ? <ErrorState message={t('console.loadError')} onRetry={() => void reload()} /> : (
        <div className="space-y-5">
          <Panel title={t('saUsage.alerts')}>
            {u.alerts.length === 0 ? <p className="text-sm text-muted">{t('saUsage.noAlerts')}</p> : (
              <div className="space-y-2">
                {u.alerts.map((a, i) => (
                  <InlineAlert key={i} tone={a.level === 'critical' ? 'danger' : 'signal'}>
                    {t(`saUsage.alert.${a.type}`, { spent: a.spent_usd ?? 0, budget: a.budget_usd ?? 0, cap: a.cap_usd ?? 0, org: a.organization ?? '', failed: a.failed ?? 0, total: a.total ?? 0, jobs: a.jobs ?? 0 })}
                  </InlineAlert>
                ))}
              </div>
            )}
          </Panel>

          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Kpi label={t('saUsage.tokens')} value={num(u.tokens.input + u.tokens.output)} sub={t('saUsage.tokensDetail', { input: num(u.tokens.input), output: num(u.tokens.output) })} />
            <Kpi label={t('saUsage.aiCost')} value={usd(u.ai_cost_usd)} />
            <Kpi label={t('saUsage.requests')} value={num(u.ai_requests.total)} sub={t('saUsage.requestsDetail', { failed: u.ai_requests.failed, missing: u.ai_requests.without_cost })} />
            <Kpi label={t('saUsage.providerCost')} value={usd(u.provider_cost_usd)} sub={t('saUsage.providerRequests', { n: u.providers.reduce((a, p) => a + Number(p.requests), 0) })} />
            <Kpi label={t('saUsage.credits')} hint={t('saUsage.creditsHint')} value={num(u.credits_used)} sub={t('saUsage.creditsHint')} />
            <Kpi label={t('saUsage.leads')} value={num(u.leads_acquired)} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title={t('saUsage.dailyCost')}>
              <ColumnChart title={t('saUsage.dailyCost')} points={u.daily.map((d) => ({ label: formatDate(d.day), value: Math.round((d.ai_cost_usd + d.provider_cost_usd) * 100) / 100 }))} />
            </Panel>
            <Panel title={t('saUsage.dailyTokens')}>
              <ColumnChart title={t('saUsage.dailyTokens')} points={u.daily.map((d) => ({ label: formatDate(d.day), value: d.tokens }))} />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title={t('saUsage.byModel')}>
              <Table minWidth={480} head={[t('saUsage.colModel'), t('saUsage.colRequests'), t('saUsage.colFailed'), t('saUsage.colTokens'), t('saUsage.colCost')]}>
                {u.by_model.map((m) => (
                  <tr key={m.model}>
                    <td className="py-2 pr-3 font-mono text-xs">{m.model}</td>
                    <td className="tabular py-2 pr-3">{num(m.requests)}</td>
                    <td className="tabular py-2 pr-3">{num(m.failed)}</td>
                    <td className="tabular py-2 pr-3">{num(m.tokens_input)} / {num(m.tokens_output)}</td>
                    <td className="tabular py-2">{usd(m.cost_usd)}{m.without_cost ? ' *' : ''}</td>
                  </tr>
                ))}
              </Table>
            </Panel>
            <Panel title={t('saUsage.providers')}>
              <Table minWidth={360} head={[t('saUsage.colProvider'), t('saUsage.colRequests'), t('saUsage.colCost')]}>
                {u.providers.map((p) => (
                  <tr key={p.provider}>
                    <td className="py-2 pr-3 font-mono text-xs">{p.provider}</td>
                    <td className="tabular py-2 pr-3">{num(p.requests)}</td>
                    <td className="tabular py-2">{usd(p.cost_usd)}{p.without_cost ? ' *' : ''}</td>
                  </tr>
                ))}
              </Table>
            </Panel>
          </div>

          <Panel title={t('saUsage.byPlan')}>
            <p className="mb-2 text-xs text-muted">{t('saUsage.planMarginNote')}</p>
            <Table minWidth={560} head={[t('saUsage.colPlan'), t('saUsage.colOrg'), t('saUsage.colCollected'), t('saUsage.aiCost'), t('saUsage.providerCost'), t('saUsage.credits')]}>
              {u.by_plan.map((p) => (
                <tr key={p.plan_code}>
                  <td className="py-2 pr-3 capitalize">{p.plan_code}</td>
                  <td className="tabular py-2 pr-3">{num(p.organizations)}</td>
                  <td className="tabular py-2 pr-3">{money(p.net_collected_cents)}</td>
                  <td className="tabular py-2 pr-3">{usd(p.ai_cost_usd)}</td>
                  <td className="tabular py-2 pr-3">{usd(p.provider_cost_usd)}</td>
                  <td className="tabular py-2">{num(p.credits)}</td>
                </tr>
              ))}
            </Table>
          </Panel>

          <Panel title={t('saUsage.byOrg')}>
            <Table minWidth={820} head={[t('saUsage.colOrg'), t('saUsage.colPlan'), t('saUsage.colTokens'), t('saUsage.aiCost'), t('saUsage.providerCost'), t('saUsage.colFailed'), t('saUsage.credits'), t('saUsage.colCap')]}>
              {u.organizations.map((o) => (
                <tr key={o.id}>
                  <td className="max-w-[200px] truncate py-2 pr-3">{o.name}</td>
                  <td className="py-2 pr-3 capitalize">{o.plan_code ?? '—'}</td>
                  <td className="tabular py-2 pr-3">{num(o.tokens)}</td>
                  <td className="tabular py-2 pr-3">{usd(o.ai_cost_usd)}</td>
                  <td className="tabular py-2 pr-3">{usd(o.provider_cost_usd)}</td>
                  <td className="tabular py-2 pr-3">{num(o.failed_jobs)}</td>
                  <td className="tabular py-2 pr-3">{num(o.credits)}</td>
                  <td className="tabular py-2">{o.cap_usd == null ? '—' : `${usd(o.month_ai_cost_usd)} / ${usd(o.cap_usd)}`}</td>
                </tr>
              ))}
            </Table>
          </Panel>

          <Controls key={JSON.stringify([u.cost_controls, u.operations])} cc={u.cost_controls} ops={u.operations} onSaved={() => void reload()} />
        </div>
      )}
    </>
  )
}
