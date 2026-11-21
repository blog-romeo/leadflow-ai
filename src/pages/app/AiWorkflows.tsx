import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Network, Sparkles } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { apiFetch } from '../../lib/api'
import type { AiAgentApprovalRow, AiAgentRunRow, AiWorkflowRow, AiWorkflowStepRow } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Field, Select, controlClasses } from '../../components/ui/Field'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { ConfigNotice } from '../../components/ui/ConfigNotice'
import { WorkflowDetail } from '../../features/ai-agents/WorkflowDetail'
import { actionKey, aiErrorMessage, newIdempotencyKey, StatusBadge, TERMINAL, useAgentsStatus, usePolling, type Plan, type PlanResponse } from '../../features/ai-agents/shared'

type Template = Plan['template']
type Params = Record<string, unknown>

const NUMBER_FIELDS: Record<Template, string[]> = {
  prospecting: ['max_results', 'analyze_top', 'proposals_top', 'min_score'],
  follow_up_review: ['stale_days', 'opportunity_stale_days', 'max_tasks', 'drafts_max'],
  growth_report: ['period_days'],
}
const DEFAULTS: Record<Template, Params> = {
  prospecting: { sector: '', location: '', country: 'IT', keywords: '', website_filter: 'any', company_size: 'any', max_results: 30, analyze_top: 10, proposals_top: 5, min_score: 50 },
  follow_up_review: { stale_days: 14, opportunity_stale_days: 30, max_tasks: 25, prepare_drafts: false, drafts_max: 3 },
  growth_report: { period_days: 90 },
}

function ParamsForm({ template, params, onChange }: { template: Template; params: Params; onChange: (p: Params) => void }) {
  const { t } = useI18n()
  const set = (k: string, v: unknown) => onChange({ ...params, [k]: v })
  const num = (k: string) => (
    <Field key={k} label={t(`aiWorkflows.params.${k}`)} type="number" min={0} value={String(params[k] ?? '')} onChange={(e) => set(k, e.target.value === '' ? '' : Number(e.target.value))} />
  )
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {template === 'prospecting' && (
        <>
          <Field label={t('aiWorkflows.params.sector')} value={String(params.sector ?? '')} maxLength={80} onChange={(e) => set('sector', e.target.value)} />
          <Field label={t('aiWorkflows.params.location')} value={String(params.location ?? '')} maxLength={120} onChange={(e) => set('location', e.target.value)} />
          <Field label={t('aiWorkflows.params.country')} value={String(params.country ?? 'IT')} maxLength={2} onChange={(e) => set('country', e.target.value.toUpperCase())} />
          <Field label={t('aiWorkflows.params.keywords')} value={String(params.keywords ?? '')} maxLength={200} onChange={(e) => set('keywords', e.target.value)} />
          <Select label={t('aiWorkflows.params.website_filter')} value={String(params.website_filter ?? 'any')} onChange={(e) => set('website_filter', e.target.value)}>
            {(['any', 'with', 'without'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`aiWorkflows.params.website.${x}`)}
              </option>
            ))}
          </Select>
          <Select label={t('aiWorkflows.params.company_size')} value={String(params.company_size ?? 'any')} onChange={(e) => set('company_size', e.target.value)}>
            {(['any', 'micro', 'small', 'medium', 'large'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`aiWorkflows.params.sizes.${x}`)}
              </option>
            ))}
          </Select>
        </>
      )}
      {NUMBER_FIELDS[template].map(num)}
      {template === 'follow_up_review' && (
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--color-flow)]" checked={!!params.prepare_drafts} onChange={(e) => set('prepare_drafts', e.target.checked)} />
          {t('aiWorkflows.params.prepare_drafts')}
        </label>
      )}
    </div>
  )
}

function cleanParams(template: Template, p: Params): Params {
  const allowed = Object.keys(DEFAULTS[template])
  const out: Params = {}
  for (const k of allowed) {
    const v = p[k]
    if (v === '' || v === undefined) continue
    out[k] = v
  }
  return out
}

export default function AiWorkflows() {
  const { t, formatDate } = useI18n()
  const { currentOrg, isOrgAdmin, user } = useAuth()
  const orgId = currentOrg?.id
  const { status, error } = useAgentsStatus(orgId)
  const [search, setSearch] = useSearchParams()
  const selectedId = search.get('id')

  const [objective, setObjective] = useState('')
  const [template, setTemplate] = useState<Template>('prospecting')
  const [params, setParams] = useState<Params>(DEFAULTS.prospecting)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [interp, setInterp] = useState<PlanResponse['interpretation']>(null)
  const [invalid, setInvalid] = useState<string[]>([])
  const [budget, setBudget] = useState('0')
  const [busy, setBusy] = useState<'plan' | 'start' | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [idemKey, setIdemKey] = useState(newIdempotencyKey)

  const [list, setList] = useState<AiWorkflowRow[] | null>(null)
  const [detail, setDetail] = useState<{ wf: AiWorkflowRow; steps: AiWorkflowStepRow[]; approvals: AiAgentApprovalRow[]; runs: AiAgentRunRow[] } | null>(null)

  const loadList = useCallback(async () => {
    if (!supabase || !orgId) return
    const { data } = await supabase.from('ai_workflows').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(25)
    setList((data ?? []) as AiWorkflowRow[])
  }, [orgId])
  const loadDetail = useCallback(async () => {
    if (!supabase || !orgId || !selectedId) return setDetail(null)
    const [w, s, a, r] = await Promise.all([
      supabase.from('ai_workflows').select('*').eq('organization_id', orgId).eq('id', selectedId).maybeSingle(),
      supabase.from('ai_workflow_steps').select('*').eq('organization_id', orgId).eq('workflow_id', selectedId).order('position'),
      supabase.from('ai_agent_approvals').select('*').eq('organization_id', orgId).eq('workflow_id', selectedId).order('requested_at', { ascending: false }),
      // Solo colonne numeriche e di stato (l'envelope completo non serve all'interfaccia).
      supabase.from('ai_agent_runs').select('id, organization_id, workflow_id, step_id, agent_key, attempt, status, error_code, items_total, items_failed, credits_used, tokens_input, tokens_output, cost_usd, model, started_at, completed_at').eq('organization_id', orgId).eq('workflow_id', selectedId).order('started_at').limit(200),
    ])
    setDetail(w.data ? { wf: w.data as AiWorkflowRow, steps: (s.data ?? []) as AiWorkflowStepRow[], approvals: (a.data ?? []) as AiAgentApprovalRow[], runs: (r.data ?? []) as unknown as AiAgentRunRow[] } : null)
  }, [orgId, selectedId])

  useEffect(() => {
    if (status?.enabled) void loadList()
  }, [status?.enabled, loadList])
  useEffect(() => {
    if (status?.enabled) void loadDetail()
  }, [status?.enabled, loadDetail])
  const polling = !!detail && !TERMINAL.includes(detail.wf.status)
  usePolling(() => {
    void loadDetail()
    void loadList()
  }, 4000, polling)

  const missingText = useMemo(
    () => (plan?.missing ?? []).map((m) => {
      const base = t(`aiWorkflows.missing.${m.code}`, { component: m.component, feature: m.feature ?? '', fields: (m.fields ?? []).join(', ') })
      return m.env?.length ? `${base} ${t('aiWorkflows.missing.env', { vars: m.env.join(', ') })}` : base
    }),
    [plan, t],
  )

  async function requestPlan(withObjective: boolean) {
    if (!orgId) return
    setBusy('plan')
    setMsg(null)
    try {
      const body = withObjective ? { organization_id: orgId, objective } : { organization_id: orgId, template, params: cleanParams(template, params) }
      const res = await apiFetch<PlanResponse>('/api/ai-workflows/plan', { method: 'POST', body })
      setInvalid(res.invalid_fields ?? [])
      if (withObjective && res.interpretation) {
        setInterp(res.interpretation)
        setTemplate(res.interpretation.template)
        setParams({ ...DEFAULTS[res.interpretation.template], ...res.interpretation.params })
      }
      setPlan(res.plan)
      if (res.plan) {
        setParams({ ...DEFAULTS[res.plan.template], ...res.plan.params })
        setBudget(String(res.plan.estimate.max_credits))
      }
      setIdemKey(newIdempotencyKey())
    } catch (e) {
      setMsg({ tone: 'danger', text: aiErrorMessage(e, t) })
    } finally {
      setBusy(null)
    }
  }

  async function start() {
    if (!orgId || !plan) return
    setBusy('start')
    setMsg(null)
    try {
      const res = await apiFetch<{ workflow_id: string }>('/api/ai-workflows/start', {
        method: 'POST',
        body: { organization_id: orgId, template: plan.template, params: plan.params, objective: objective || undefined, budget_credits: Math.max(0, Math.floor(Number(budget) || 0)), idempotency_key: idemKey },
      })
      setMsg({ tone: 'ok', text: t('aiWorkflows.plan.started') })
      setPlan(null)
      setSearch({ id: res.workflow_id })
      void loadList()
    } catch (e) {
      setMsg({ tone: 'danger', text: aiErrorMessage(e, t) })
    } finally {
      setBusy(null)
    }
  }

  if (!supabase) return <ConfigNotice />
  if (error) return <ErrorState message={aiErrorMessage(error, t)} />
  if (!status) return <LoadingState />
  if (!status.enabled) {
    return (
      <>
        <PageHeader title={t('aiWorkflows.title')} subtitle={t('aiWorkflows.subtitle')} />
        <Panel>
          <EmptyState icon={Network} title={t('aiAgents.disabledTitle')} body={status.pilot ? t('aiAgents.pilotBody') : t('aiAgents.disabledBody')} />
        </Panel>
      </>
    )
  }

  return (
    <>
      <PageHeader title={t('aiWorkflows.title')} subtitle={t('aiWorkflows.subtitle')} />
      <Panel className="mb-4">
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            void requestPlan(true)
          }}
        >
          <label className="block space-y-1.5">
            <span className="block text-sm font-medium">{t('aiWorkflows.objective')}</span>
            <textarea className={`${controlClasses} h-20 py-2`} maxLength={1000} placeholder={t('aiWorkflows.objectivePlaceholder')} value={objective} onChange={(e) => setObjective(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={busy === 'plan'} disabled={!objective.trim()}>
              <Sparkles className="size-4" aria-hidden />
              {t('aiWorkflows.interpret')}
            </Button>
            <span className="text-xs text-muted">{t('aiWorkflows.interpretedNote')}</span>
          </div>
        </form>
        {interp && (
          <div className="mt-3 space-y-1 text-xs text-muted">
            <p>{t('aiWorkflows.recognized', { fields: interp.recognized.join(', ') })}</p>
            {interp.warnings.map((w) => (
              <p key={w}>{t(`aiWorkflows.warnings.${w}`)}</p>
            ))}
          </div>
        )}
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <Select
            label={t('aiWorkflows.template')}
            value={template}
            onChange={(e) => {
              const tp = e.target.value as Template
              setTemplate(tp)
              setParams(DEFAULTS[tp])
              setPlan(null)
            }}
          >
            {(['prospecting', 'follow_up_review', 'growth_report'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`aiWorkflows.templates.${x}`)} — {t(`aiWorkflows.templateDesc.${x}`)}
              </option>
            ))}
          </Select>
          <ParamsForm template={template} params={params} onChange={(p) => { setParams(p); setPlan(null) }} />
          {invalid.length > 0 && <InlineAlert>{`${t('aiWorkflows.codes.generic')}: ${invalid.join(', ')}`}</InlineAlert>}
          <Button variant="secondary" loading={busy === 'plan'} onClick={() => void requestPlan(false)}>
            {t('aiWorkflows.plan.update')}
          </Button>
        </div>
        {plan && (
          <div className="mt-4 space-y-3 border-t border-line pt-4">
            <h2 className="text-base font-semibold">{t('aiWorkflows.plan.title')}</h2>
            <ol className="space-y-1 text-sm">
              {plan.steps.map((s) => (
                <li key={s.position} className="flex flex-wrap items-center gap-2">
                  <span className="grid size-6 place-items-center rounded-full bg-surface-2 text-xs font-semibold">{s.position}</span>
                  {t(`aiWorkflows.actions.${actionKey(s.action)}`)}
                  <span className="text-xs text-muted">{t(`aiAgents.agents.${s.agentKey}.name`)}</span>
                  {s.requiresApproval && <Badge tone="signal">{t('aiWorkflows.plan.approvals')}</Badge>}
                </li>
              ))}
            </ol>
            <p className="text-sm">{t('aiWorkflows.plan.estimate', { credits: plan.estimate.max_credits })}</p>
            <p className="text-xs text-muted">{t('aiWorkflows.plan.estimateNote')}</p>
            {plan.warnings.map((w) => (
              <InlineAlert key={w} tone="signal">
                {t(`aiWorkflows.warnings.${w}`)}
              </InlineAlert>
            ))}
            {plan.blocked ? (
              <InlineAlert>
                <p>{t('aiWorkflows.plan.blocked')}</p>
                <ul className="mt-1 list-disc pl-5 font-normal">
                  {missingText.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </InlineAlert>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <Field className="w-56" label={t('aiWorkflows.plan.budget')} hint={t('aiWorkflows.plan.budgetHint')} type="number" min={0} max={5000} value={budget} onChange={(e) => setBudget(e.target.value)} />
                <Button loading={busy === 'start'} onClick={() => void start()}>
                  {t('aiWorkflows.plan.start')}
                </Button>
              </div>
            )}
          </div>
        )}
        {msg && (
          <div className="mt-3">
            <InlineAlert tone={msg.tone}>{msg.text}</InlineAlert>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
        <Panel title={t('aiWorkflows.list.title')}>
          {list === null ? (
            <LoadingState />
          ) : list.length === 0 ? (
            <p className="text-sm text-muted">{t('aiWorkflows.list.empty')}</p>
          ) : (
            <ul className="-mx-2 space-y-1">
              {list.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => setSearch({ id: w.id })}
                    className={`w-full rounded-[var(--radius-control)] px-2 py-2 text-left text-sm hover:bg-surface-2 ${w.id === selectedId ? 'bg-surface-2' : ''}`}
                    aria-current={w.id === selectedId ? 'true' : undefined}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{t(`aiWorkflows.templates.${w.template}`)}</span>
                      <StatusBadge status={w.status} label={t(`aiWorkflows.status.${w.status}`)} />
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {formatDate(w.created_at)} · {t('aiWorkflows.list.budget', { used: w.credits_used, budget: w.budget_credits })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          {detail && orgId ? (
            <WorkflowDetail
              workflow={detail.wf}
              steps={detail.steps}
              approvals={detail.approvals}
              runs={detail.runs}
              orgId={orgId}
              isAdmin={isOrgAdmin}
              canCancel={isOrgAdmin || detail.wf.created_by === user?.id}
              onChanged={() => {
                void loadDetail()
                void loadList()
              }}
            />
          ) : (
            <p className="text-sm text-muted">{t('aiWorkflows.detail.noSelection')}</p>
          )}
        </Panel>
      </div>
    </>
  )
}
