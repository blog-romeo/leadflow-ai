import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrainCircuit, CircleSlash, PlugZap, Rocket } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { AI_AGENT_KEYS, type AiAgentApprovalRow, type AiAgentKey, type AiAgentRow, type AiAgentRunRow, type AiFeedbackRow, type AiModelTier, type AiWorkflowRow, type Json } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button, buttonClasses } from '../../components/ui/Button'
import { Field, Select } from '../../components/ui/Field'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { ConfigNotice } from '../../components/ui/ConfigNotice'
import { ApprovalCard } from '../../features/ai-agents/ApprovalCard'
import { MemoryPanel } from '../../features/ai-agents/MemoryPanel'
import { ConnectionsPanel } from '../../features/ai-agents/ConnectionsPanel'
import { FeedbackReviewPanel } from '../../features/ai-agents/Feedback'
import { aiErrorMessage, codeMessage, controlWorkflow, StatusBadge, useAgentsStatus, usePolling, type AgentsStatus } from '../../features/ai-agents/shared'

const AI_AGENTS: AiAgentKey[] = ['research', 'strategy', 'follow_up']

function AgentSettings({ orgId, agent, row, onSaved }: { orgId: string; agent: AiAgentKey; row: AiAgentRow | undefined; onSaved: () => void }) {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(row?.enabled ?? true)
  const [tier, setTier] = useState<AiModelTier>(row?.model_tier ?? 'standard')
  const [budget, setBudget] = useState(row?.monthly_credit_budget?.toString() ?? '')
  const [runMax, setRunMax] = useState(row?.max_credits_per_run?.toString() ?? '')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  async function save() {
    if (!supabase) return
    setBusy(true)
    const patch: Record<string, unknown> = {
      enabled,
      model_tier: tier,
      monthly_credit_budget: budget.trim() === '' ? null : Math.max(0, Math.floor(Number(budget))),
      max_credits_per_run: runMax.trim() === '' ? null : Math.max(0, Math.floor(Number(runMax))),
    }
    const { error } = await supabase.rpc('ai_agent_configure', { p_org: orgId, p_agent: agent, p_patch: patch as Json })
    setBusy(false)
    setMsg(error ? { tone: 'danger', text: codeMessage(/^[a-z_]{3,60}$/.test(error.message) ? error.message : 'generic', t) } : { tone: 'ok', text: t('aiAgents.fields.saved') })
    if (!error) onSaved()
  }
  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[var(--color-flow)]" />
        {t('aiAgents.fields.enabled')}
      </label>
      {AI_AGENTS.includes(agent) && (
        <Select label={t('aiAgents.fields.tier')} value={tier} onChange={(e) => setTier(e.target.value as AiModelTier)}>
          {(['economy', 'standard', 'advanced'] as const).map((x) => (
            <option key={x} value={x}>
              {t(`aiAgents.tiers.${x}`)}
            </option>
          ))}
        </Select>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={agent === 'orchestrator' ? t('aiAgents.fields.monthlyBudgetOrg') : t('aiAgents.fields.monthlyBudget')}
          hint={t('aiAgents.fields.unlimited')}
          type="number"
          min={0}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
        <Field label={t('aiAgents.fields.runMax')} hint={t('aiAgents.fields.unlimited')} type="number" min={0} value={runMax} onChange={(e) => setRunMax(e.target.value)} />
      </div>
      {msg && <InlineAlert tone={msg.tone}>{msg.text}</InlineAlert>}
      <Button size="sm" loading={busy} onClick={() => void save()}>
        {t('aiAgents.fields.save')}
      </Button>
    </div>
  )
}

function agentState(key: AiAgentKey, row: AiAgentRow | undefined, st: AgentsStatus): 'active' | 'disabled' | 'missingConfig' | 'noPlan' {
  if (row && !row.enabled) return 'disabled'
  const cat = st.catalog?.find((c) => c.key === key)
  const av = st.availability
  if (!cat || !av) return 'active'
  if (cat.features.some((f) => av.features[f] === false)) return 'noPlan'
  if (key === 'discovery' && !av.providers.some((p) => p.configured && p.canStore)) return 'missingConfig'
  if (cat.uses_ai && !av.ai.configured) return 'missingConfig'
  return 'active'
}

export default function AiAgents() {
  const { t, formatDate } = useI18n()
  const { currentOrg, isOrgAdmin, user } = useAuth()
  const orgId = currentOrg?.id
  const { status, error, reload } = useAgentsStatus(orgId)
  const [configs, setConfigs] = useState<AiAgentRow[]>([])
  const [runs, setRuns] = useState<AiAgentRunRow[]>([])
  const [approvals, setApprovals] = useState<AiAgentApprovalRow[]>([])
  const [active, setActive] = useState<AiWorkflowRow[]>([])
  const [feedback, setFeedback] = useState<AiFeedbackRow[]>([])
  const [openSettings, setOpenSettings] = useState<AiAgentKey | null>(null)
  const [stopErr, setStopErr] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!supabase || !orgId) return
    const [c, r, a, w, f] = await Promise.all([
      supabase.from('ai_agents').select('*').eq('organization_id', orgId),
      supabase.from('ai_agent_runs').select('*').eq('organization_id', orgId).order('started_at', { ascending: false }).limit(60),
      supabase.from('ai_agent_approvals').select('*').eq('organization_id', orgId).eq('status', 'pending').order('requested_at', { ascending: false }),
      supabase.from('ai_workflows').select('*').eq('organization_id', orgId).in('status', ['pending', 'running', 'waiting_approval']).order('created_at', { ascending: false }),
      supabase.from('ai_feedback').select('*').eq('organization_id', orgId).eq('status', 'pending').order('created_at', { ascending: false }).limit(20),
    ])
    setFeedback((f.data ?? []) as AiFeedbackRow[])
    setConfigs((c.data ?? []) as AiAgentRow[])
    setRuns((r.data ?? []) as AiAgentRunRow[])
    setApprovals((a.data ?? []) as AiAgentApprovalRow[])
    setActive((w.data ?? []) as AiWorkflowRow[])
  }, [orgId])

  useEffect(() => {
    if (status?.enabled) void loadData()
  }, [status?.enabled, loadData])
  usePolling(() => void loadData(), 5000, !!status?.enabled && active.length > 0)

  if (!supabase) return <ConfigNotice />
  if (error) return <ErrorState message={aiErrorMessage(error, t)} onRetry={() => void reload()} />
  if (!status) return <LoadingState />

  if (!status.enabled) {
    return (
      <>
        <PageHeader title={t('aiAgents.title')} subtitle={t('aiAgents.subtitle')} />
        <Panel>
          <EmptyState icon={BrainCircuit} title={t('aiAgents.disabledTitle')} body={status.pilot ? t('aiAgents.pilotBody') : t('aiAgents.disabledBody')} />
        </Panel>
      </>
    )
  }

  const av = status.availability!
  const lastRun = (k: AiAgentKey) => runs.find((r) => r.agent_key === k)
  const failed = runs.filter((r) => r.status === 'failed' || r.status === 'timed_out').slice(0, 8)
  const storeProviders = av.providers.filter((p) => p.canStore)
  const missingProviderEnv = [...new Set(storeProviders.flatMap((p) => p.missing))]

  async function stop(w: AiWorkflowRow) {
    if (!orgId || !window.confirm(t('aiAgents.running.stopConfirm'))) return
    setStopErr(null)
    try {
      await controlWorkflow(orgId, w.id, 'cancel')
      void loadData()
    } catch (e) {
      setStopErr(aiErrorMessage(e, t))
    }
  }

  return (
    <>
      <PageHeader
        title={t('aiAgents.title')}
        subtitle={t('aiAgents.subtitle')}
        actions={
          <Link to="/app/ai-workflows" className={buttonClasses('primary', 'md')}>
            <Rocket className="size-4" aria-hidden />
            {t('aiAgents.startWorkflow')}
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="signal">{t('aiAgents.beta')}</Badge>
        <span className="text-muted">{t('aiAgents.creditsMonth', { credits: status.spend_month?.credits ?? 0 })}</span>
      </div>

      {orgId && <ConnectionsPanel status={status} orgId={orgId} onChecked={() => void reload()} />}
      {isOrgAdmin && (
        <Panel title={t('aiFeedback.reviewTitle')} className="mb-4">
          <FeedbackReviewPanel rows={feedback} onDone={() => void loadData()} />
          <p className="mt-3 text-xs text-muted">{t('aiFeedback.reviewNote')}</p>
        </Panel>
      )}

      {(!storeProviders.some((p) => p.configured) || !av.ai.configured || av.salesProfileMissing.length > 0) && (
        <Panel title={t('aiAgents.panels.config')} className="mb-4">
          <ul className="space-y-2 text-sm">
            {!storeProviders.some((p) => p.configured) && (
              <li className="flex gap-2">
                <PlugZap className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
                <span>
                  {t('aiAgents.missing.provider')}. {status.is_admin && missingProviderEnv.length ? t('aiAgents.missing.envHint', { vars: missingProviderEnv.join(', ') }) : t('aiAgents.missing.adminHint')}
                </span>
              </li>
            )}
            {!av.ai.configured && (
              <li className="flex gap-2">
                <PlugZap className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
                <span>
                  {t('aiAgents.missing.ai')}. {status.is_admin && av.ai.missing.length ? t('aiAgents.missing.envHint', { vars: av.ai.missing.join(', ') }) : t('aiAgents.missing.adminHint')}
                </span>
              </li>
            )}
            {av.salesProfileMissing.length > 0 && (
              <li className="flex gap-2">
                <PlugZap className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
                <span>
                  {t('aiAgents.missing.profile', { fields: av.salesProfileMissing.join(', ') })} — <Link className="text-flow hover:underline" to="/app/sales-agent/profile">{t('nav.salesAgent')}</Link>
                </span>
              </li>
            )}
          </ul>
        </Panel>
      )}

      <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {AI_AGENT_KEYS.map((k) => {
          const row = configs.find((c) => c.agent_key === k)
          const state = agentState(k, row, status)
          const cat = status.catalog?.find((c) => c.key === k)
          const tier = row?.model_tier ?? (cat?.default_tier as AiModelTier | undefined) ?? 'standard'
          const lr = lastRun(k)
          return (
            <section key={k} className="flex flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-4">
              <header className="flex items-start justify-between gap-2">
                <h2 className="text-base font-semibold">{t(`aiAgents.agents.${k}.name`)}</h2>
                <Badge tone={state === 'active' ? 'ok' : state === 'disabled' ? 'neutral' : 'signal'}>{t(`aiAgents.status.${state}`)}</Badge>
              </header>
              <p className="mt-1 text-sm text-muted">{t(`aiAgents.agents.${k}.description`)}</p>
              <dl className="mt-3 space-y-1 text-xs text-muted">
                <div>{cat?.uses_ai ? `${t('aiAgents.usesAi')} · ${t(`aiAgents.tiers.${tier}`)}${av.models[tier]?.fallback ? ` (${t('aiAgents.tierFallback')})` : ''}` : t('aiAgents.noAi')}</div>
                <div>{lr ? t('aiAgents.lastRun', { date: formatDate(lr.started_at) }) : t('aiAgents.neverRun')}</div>
                <div>{t('aiAgents.creditsMonth', { credits: status.spend_month?.byAgent[k] ?? 0 })}</div>
              </dl>
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-muted">{t('aiAgents.tools')}</summary>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {cat?.tools.map((tool) => (
                    <code key={tool} className="rounded bg-surface-2 px-1.5 py-0.5">
                      {tool}
                    </code>
                  ))}
                </div>
              </details>
              {isOrgAdmin && orgId && (
                <div className="mt-auto pt-3">
                  <Button variant="ghost" size="sm" onClick={() => setOpenSettings(openSettings === k ? null : k)}>
                    {t('aiAgents.settings')}
                  </Button>
                  {openSettings === k && <AgentSettings orgId={orgId} agent={k} row={row} onSaved={() => void loadData()} />}
                </div>
              )}
            </section>
          )
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t('aiAgents.panels.approvals')}>
          {approvals.length === 0 ? (
            <p className="text-sm text-muted">{t('aiAgents.approvals.empty')}</p>
          ) : (
            <div className="space-y-3">
              {approvals.map((a) => (
                <ApprovalCard key={a.id} approval={a} orgId={orgId!} isAdmin={isOrgAdmin} onDone={() => void loadData()} />
              ))}
            </div>
          )}
        </Panel>
        <Panel title={t('aiAgents.panels.running')}>
          {stopErr && <InlineAlert>{stopErr}</InlineAlert>}
          {active.length === 0 ? (
            <p className="text-sm text-muted">{t('aiAgents.running.empty')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {active.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <div className="min-w-0">
                    <Link to={`/app/ai-workflows?id=${w.id}`} className="font-medium hover:text-flow hover:underline">
                      {t(`aiWorkflows.templates.${w.template}`)}
                    </Link>
                    <p className="truncate text-xs text-muted">{w.objective ?? formatDate(w.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={w.status} label={t(`aiWorkflows.status.${w.status}`)} />
                    {(isOrgAdmin || w.created_by === user?.id) && (
                      <Button variant="secondary" size="sm" onClick={() => void stop(w)}>
                        <CircleSlash className="size-4" aria-hidden />
                        {t('aiAgents.running.stop')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t('aiAgents.panels.errors')}>
          {failed.length === 0 ? (
            <p className="text-sm text-muted">{t('aiAgents.errors.empty')}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {failed.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    <span className="font-medium">{t(`aiAgents.agents.${r.agent_key}.name`)}</span> — {codeMessage(r.error_code, t)}
                  </span>
                  <span className="text-xs text-muted">{formatDate(r.started_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t('aiAgents.panels.history')}>
          {runs.length === 0 ? (
            <p className="text-sm text-muted">{t('aiAgents.history.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">{t('aiAgents.history.agent')}</th>
                    <th className="py-1.5 pr-3 font-medium">{t('aiAgents.history.status')}</th>
                    <th className="py-1.5 pr-3 font-medium">{t('aiAgents.history.items')}</th>
                    <th className="py-1.5 pr-3 font-medium">{t('aiAgents.history.credits')}</th>
                    <th className="py-1.5 font-medium">{t('aiAgents.history.started')}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 20).map((r) => (
                    <tr key={r.id} className="border-t border-line">
                      <td className="py-1.5 pr-3">{t(`aiAgents.agents.${r.agent_key}.name`)}</td>
                      <td className="py-1.5 pr-3">
                        <StatusBadge status={r.status} label={t(`aiAgents.runStatus.${r.status}`)} />
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {r.items_total - r.items_failed}/{r.items_total}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">{r.credits_used}</td>
                      <td className="py-1.5 text-xs text-muted">{formatDate(r.started_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel title={t('aiAgents.panels.memory')} className="mt-4">
        {orgId && <MemoryPanel orgId={orgId} isAdmin={isOrgAdmin} />}
      </Panel>
    </>
  )
}
