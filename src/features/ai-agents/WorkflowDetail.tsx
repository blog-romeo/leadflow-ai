import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CircleSlash, Download } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { AiAgentApprovalRow, AiAgentRunRow, AiWorkflowRow, AiWorkflowStepRow, Json } from '../../lib/database.types'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { ApprovalCard } from './ApprovalCard'
import { FeedbackButtons } from './Feedback'
import { download, formatDuration, progressDone, rankingCsv, stepDurationMs, workflowJson } from './exportResults'
import { actionKey, aiErrorMessage, codeMessage, controlWorkflow, StatusBadge, TERMINAL } from './shared'

type O = Record<string, unknown>
const obj = (v: unknown): O => (v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : {})
const arr = <X = O,>(v: unknown): X[] => (Array.isArray(v) ? (v as X[]) : [])
const n = (v: unknown) => (typeof v === 'number' ? v : 0)

function Kind({ basis }: { basis: string }) {
  const { t } = useI18n()
  const tone = basis === 'fact' ? 'ok' : basis === 'inference' ? 'signal' : 'neutral'
  return <Badge tone={tone}>{t(`aiWorkflows.out.${basis === 'fact' ? 'fact' : basis === 'inference' ? 'inference' : 'unknown'}`)}</Badge>
}

function StepOutput({ step, orgId, workflowId, isAdmin }: { step: AiWorkflowStepRow; orgId: string; workflowId: string; isAdmin: boolean }) {
  const { t, formatNumber } = useI18n()
  const o = obj(step.output)
  const c = obj(o.counts)
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  if (!step.output || step.status === 'waiting_approval') return null

  if (step.action === 'discover' && o.provider) {
    const m = obj(o.missing_data)
    return (
      <div className="space-y-1 text-sm">
        <p>{t('aiWorkflows.out.discovery', { found: n(c.found), new: n(c.new), dup: n(c.duplicates_in_batch), crm: n(c.in_crm), provider: String(o.provider) })}</p>
        <p className="text-xs text-muted">{t('aiWorkflows.out.missingData', { website: n(m.website), phone: n(m.phone), address: n(m.address), size: n(m.company_size) })}</p>
        {typeof o.attribution === 'string' && o.attribution && <p className="text-xs text-muted">{o.attribution}</p>}
      </div>
    )
  }
  if (step.action === 'research' && o.counts) {
    return (
      <div className="space-y-1 text-sm">
        <p>{t('aiWorkflows.out.research', { analyzed: n(c.analyzed), cached: n(c.cached), failed: n(c.failed), facts: n(c.facts), inferences: n(c.inferences), unknowns: n(c.unknowns) })}</p>
        {n(c.intent_removed) > 0 && <p className="text-xs text-muted">{t('aiWorkflows.out.intentRemoved', { count: n(c.intent_removed) })}</p>}
      </div>
    )
  }
  if (step.action === 'score' && o.ranked) {
    const ranked = arr(o.ranked).slice(0, 15)
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted">{t('aiWorkflows.out.measure')}</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-medium">{t('aiWorkflows.out.cols.company')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('aiWorkflows.out.cols.score')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('aiWorkflows.out.cols.priority')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('aiWorkflows.out.cols.suggestion')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('aiWorkflows.out.cols.missing')}</th>
                <th className="py-1.5 font-medium"><span className="sr-only">{t('aiFeedback.title')}</span></th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => (
                <tr key={String(r.candidate_id)} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3">{String(r.company_name ?? '—')}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{n(r.score)}</td>
                  <td className="py-1.5 pr-3">{t(`leadFinder.priority.${String(r.priority)}`)}</td>
                  <td className="py-1.5 pr-3">{t(`aiWorkflows.suggestions.${String(r.suggestion)}`)}</td>
                  <td className="py-1.5 pr-3 text-xs text-muted">{arr<string>(r.missing).slice(0, 4).join(', ') || '—'}</td>
                  <td className="py-1.5"><FeedbackButtons orgId={orgId} workflowId={workflowId} agent="scoring" subjectType="candidate" subjectId={String(r.candidate_id)} correction={{ priority: String(r.priority) }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }
  if (step.action === 'crm.save_leads' && o.counts) {
    const other = n(c.total) - n(c.saved) - n(c.already_saved)
    return <p className="text-sm">{t('aiWorkflows.out.saved', { saved: n(c.saved), already: n(c.already_saved), other })}</p>
  }
  if (step.action === 'strategy' && o.strategies) {
    const items = arr(o.strategies)
    async function approveToMemory(item: O) {
      if (!supabase) return
      const s = obj(item.strategy)
      const content = { lead_id: item.lead_id, company_name: item.company_name, workflow_id: workflowId, opportunity: s.opportunity, recommended_service_name: s.recommended_service_name, value_proposition: s.value_proposition, approach: s.approach }
      const { error } = await supabase.rpc('ai_memory_upsert', { p_org: orgId, p_category: 'approved_strategies', p_entry_key: `lead:${String(item.lead_id)}`, p_content: content as Json })
      if (!error) setSaved((x) => ({ ...x, [String(item.lead_id)]: true }))
    }
    return (
      <div className="space-y-3">
        {items.map((item) => {
          const s = obj(item.strategy)
          const opp = obj(s.opportunity)
          const warnings = arr<{ code: string; detail?: string }>(item.warnings)
          return (
            <article key={String(item.lead_id)} className="rounded-[var(--radius-control)] border border-line p-3 text-sm">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <Link to={`/app/sales-agent/leads/${String(item.lead_id)}?tab=messages`} className="font-semibold hover:text-flow hover:underline">
                  {String(item.company_name ?? '—')}
                </Link>
                <div className="flex items-center gap-1.5">
                  {item.strategy ? <FeedbackButtons orgId={orgId} workflowId={workflowId} agent="strategy" subjectType="lead" subjectId={String(item.lead_id)} /> : null}
                  {item.status === 'cached' && <Badge>{t('aiWorkflows.out.cached')}</Badge>}
                  {item.status === 'failed' && <Badge tone="danger">{codeMessage(String(item.error ?? ''), t)}</Badge>}
                </div>
              </header>
              {item.strategy ? (
                <dl className="mt-2 space-y-2">
                  <div>
                    <dt className="flex items-center gap-2 text-xs font-medium text-muted">
                      {t('aiWorkflows.out.opportunity')} <Kind basis={String(opp.basis ?? 'inference')} />
                    </dt>
                    <dd>{String(opp.statement ?? '')}</dd>
                    {opp.basis === 'fact' && opp.evidence ? <dd className="text-xs text-muted">“{String(opp.evidence)}”</dd> : null}
                  </div>
                  {s.recommended_service_name ? (
                    <div>
                      <dt className="text-xs font-medium text-muted">{t('aiWorkflows.out.service')}</dt>
                      <dd>
                        {String(s.recommended_service_name)} — {String(s.service_rationale ?? '')}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-xs font-medium text-muted">{t('aiWorkflows.out.valueProp')}</dt>
                    <dd>{String(s.value_proposition ?? '')}</dd>
                  </div>
                  {arr(s.objections).length > 0 && (
                    <div>
                      <dt className="text-xs font-medium text-muted">{t('aiWorkflows.out.objections')}</dt>
                      <dd>
                        <ul className="list-disc space-y-0.5 pl-5">
                          {arr(s.objections).map((x, i) => (
                            <li key={i}>
                              <span className="font-medium">{String(x.objection)}</span> — {String(x.response)}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-xs font-medium text-muted">{t('aiWorkflows.out.approach', { channel: String(obj(s.approach).channel ?? '') })}</dt>
                    <dd>
                      <ol className="list-decimal space-y-0.5 pl-5">
                        {arr<string>(obj(s.approach).steps).map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ol>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted">{t('aiWorkflows.out.cta')}</dt>
                    <dd>{String(s.call_to_action ?? '')}</dd>
                  </div>
                  {arr<string>(s.missing_information).length > 0 && (
                    <div>
                      <dt className="text-xs font-medium text-muted">{t('aiWorkflows.out.missing')}</dt>
                      <dd className="text-muted">{arr<string>(s.missing_information).join(' · ')}</dd>
                    </div>
                  )}
                  {warnings.length > 0 && (
                    <div>
                      <dt className="text-xs font-medium text-muted">{t('aiWorkflows.out.warnings')}</dt>
                      <dd className="flex flex-wrap gap-1">
                        {warnings.map((w, i) => (
                          <span key={i} className="max-w-full break-words rounded-[var(--radius-control)] bg-signal-soft px-2 py-0.5 text-xs font-medium text-signal">
                            {t(`sales.warnings.${w.code}`, { detail: w.detail ?? '' }) === `sales.warnings.${w.code}` ? w.code : t(`sales.warnings.${w.code}`, { detail: w.detail ?? '' })}
                          </span>
                        ))}
                      </dd>
                    </div>
                  )}
                </dl>
              ) : null}
              <footer className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                {item.draft_id ? (
                  <Link className="font-medium text-flow hover:underline" to={`/app/sales-agent/leads/${String(item.lead_id)}?tab=messages`}>
                    {t('aiWorkflows.out.openDraft')}
                  </Link>
                ) : item.strategy ? (
                  <span className="text-muted">{t('aiWorkflows.out.noDraft')}</span>
                ) : null}
                {isAdmin && item.strategy ? (
                  saved[String(item.lead_id)] ? (
                    <span className="text-ok">{t('aiWorkflows.out.approvedMemory')}</span>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => void approveToMemory(item)}>
                      {t('aiWorkflows.out.approveMemory')}
                    </Button>
                  )
                ) : null}
              </footer>
            </article>
          )
        })}
      </div>
    )
  }
  if (step.action === 'follow_up.analyze' && o.counts) {
    return <p className="text-sm">{t('aiWorkflows.out.followUp', { create: n(c.to_create), block: n(c.to_block), overdue: n(c.overdue), stale: n(c.stale_opportunities), skipped: n(c.skipped_not_contactable) })}</p>
  }
  if (step.action === 'follow_up.apply' && o.counts) {
    return <p className="text-sm">{t('aiWorkflows.out.followUpApplied', { created: n(c.created), blocked: n(c.blocked), drafts: n(c.drafts) })}</p>
  }
  if (step.action === 'growth.analyze' && o.metrics) {
    const m = obj(o.metrics)
    const revenue = Object.entries(obj(m.revenue_attributed)).map(([cur, v]) => `${formatNumber(n(v))} ${cur}`).join(' · ') || '—'
    const rows: [string, string][] = [
      ['leads_acquired', String(n(m.leads_acquired))],
      ['leads_qualified', String(n(m.leads_qualified))],
      ['leads_contactable', String(n(m.leads_contactable))],
      ['leads_contacted', String(n(m.leads_contacted))],
      ['responses', String(n(m.responses))],
      ['appointments', String(n(m.appointments))],
      ['opportunities', String(n(m.opportunities))],
      ['customers_won', String(n(m.customers_won))],
      ['revenue', revenue],
      ['cost_per_lead', m.cost_per_lead_usd === null || m.cost_per_lead_usd === undefined ? '—' : String(m.cost_per_lead_usd)],
      ['ai_cost', String(n(m.ai_cost_usd))],
      ['agent_credits', String(n(o.agent_credits_in_period))],
    ]
    const insights = arr(o.insights)
    return (
      <div className="space-y-3 text-sm">
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">{t('aiWorkflows.out.growthTitle')}</p>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {rows.map(([k, v]) => (
              <div key={k} className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2">
                <dt className="text-xs text-muted">{t(`aiWorkflows.metrics.${k}`)}</dt>
                <dd className="font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted">{t('aiWorkflows.out.insightsTitle')}</p>
          {insights.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {insights.map((i, k) => (
                <li key={k}>{t(`aiWorkflows.insights.${String(i.code)}`, { ...(obj(i.params) as Record<string, string | number>), p: n(obj(i.test).p_value) })}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">{t('aiWorkflows.out.noInsights')}</p>
          )}
        </div>
        {arr<string>(o.data_gaps).length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted">{t('aiWorkflows.out.gapsTitle')}</p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted">
              {arr<string>(o.data_gaps).map((g) => (
                <li key={g}>{t(`aiWorkflows.gaps.${g}`)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }
  return null
}

/** Esito del Quality Reviewer (Prompt 12): solo codici e conteggi. */
function ReviewBadges({ output }: { output: Json | null }) {
  const { t } = useI18n()
  const r = obj(obj(output).review)
  const findings = obj(r.findings)
  const entries = Object.entries(findings).filter(([, v]) => typeof v === 'number' && v > 0)
  if (!('checked' in r)) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted">{t('aiReview.title')}</span>
      {entries.length === 0 ? <Badge tone="ok">{t('aiReview.ok')}</Badge> : entries.map(([k, v]) => <Badge key={k} tone="signal">{t(`aiReview.codes.${k}`)} · {String(v)}</Badge>)}
    </div>
  )
}

export function WorkflowDetail({
  workflow,
  steps,
  approvals,
  runs = [],
  orgId,
  isAdmin,
  canCancel,
  onChanged,
}: {
  workflow: AiWorkflowRow
  steps: AiWorkflowStepRow[]
  approvals: AiAgentApprovalRow[]
  /** Esecuzioni degli agenti del workflow (crediti per passo); facoltative. */
  runs?: AiAgentRunRow[]
  orgId: string
  isAdmin: boolean
  canCancel: boolean
  onChanged: () => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const pending = approvals.filter((a) => a.status === 'pending')
  const active = !TERMINAL.includes(workflow.status)
  const creditsByStep = new Map<string, number>()
  const tokensByStep = new Map<string, number>()
  for (const r of runs) if (r.step_id) creditsByStep.set(r.step_id, (creditsByStep.get(r.step_id) ?? 0) + (r.credits_used ?? 0))
  for (const r of runs) if (r.step_id) tokensByStep.set(r.step_id, (tokensByStep.get(r.step_id) ?? 0) + (r.tokens_input ?? 0) + (r.tokens_output ?? 0))
  const tokensTotal = runs.reduce((a, r) => a + (r.tokens_input ?? 0) + (r.tokens_output ?? 0), 0)
  const csv = !active ? rankingCsv(steps) : null
  const stamp = workflow.id.slice(0, 8)

  async function cancel() {
    if (!window.confirm(t('aiAgents.running.stopConfirm'))) return
    setBusy(true)
    setErr(null)
    try {
      await controlWorkflow(orgId, workflow.id, 'cancel')
      onChanged()
    } catch (e) {
      setErr(aiErrorMessage(e, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={workflow.status} label={t(`aiWorkflows.status.${workflow.status}`)} />
            <span className="text-sm font-medium">{t(`aiWorkflows.templates.${workflow.template}`)}</span>
          </div>
          {workflow.objective && <p className="max-w-2xl text-sm text-muted">{workflow.objective}</p>}
          <p className="text-xs text-muted">
            {t('aiWorkflows.detail.credits', { used: workflow.credits_used, budget: workflow.budget_credits })} ·{' '}
            {Number(workflow.cost_usd) > 0 ? t('aiWorkflows.detail.cost', { cost: Number(workflow.cost_usd).toFixed(4) }) : t('aiWorkflows.detail.costUnknown')}
          </p>
          {tokensTotal > 0 && <p className="text-xs text-muted">{t('aiWorkflowsP10.tokensTotal', { n: tokensTotal })}</p>}
          {workflow.error_code && <p className="text-xs text-danger">{codeMessage(workflow.error_code, t)}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
        {!active && (
          <Button variant="secondary" size="sm" onClick={() => download(`workflow-${stamp}.json`, 'application/json', workflowJson(workflow, steps, runs))}>
            <Download className="size-4" aria-hidden />
            {t('aiWorkflowsP9.exportJson')}
          </Button>
        )}
        {csv && (
          <Button variant="secondary" size="sm" onClick={() => download(`workflow-${stamp}-ranking.csv`, 'text/csv;charset=utf-8', csv)}>
            <Download className="size-4" aria-hidden />
            {t('aiWorkflowsP9.exportCsv')}
          </Button>
        )}
        {active && canCancel && (
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void cancel()}>
            <CircleSlash className="size-4" aria-hidden />
            {t('aiWorkflows.detail.cancel')}
          </Button>
        )}
        </div>
      </div>
      {!active && <p className="text-xs text-muted">{t('aiWorkflowsP9.exportNote')}</p>}
      {active && steps.some((s) => s.status === 'completed') && <p className="text-xs text-muted">{t('aiWorkflowsP9.partialResults')}</p>}
      {err && <InlineAlert>{err}</InlineAlert>}
      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} orgId={orgId} isAdmin={isAdmin} onDone={onChanged} />
      ))}
      <ol className="space-y-3">
        {steps.map((s) => (
          <li key={s.id} className="rounded-[var(--radius-control)] border border-line p-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-sm">
              <span className="grid size-6 place-items-center rounded-full bg-surface-2 text-xs font-semibold tabular-nums">{s.position}</span>
              <span className="font-medium">{t(`aiWorkflows.actions.${actionKey(s.action)}`)}</span>
              <span className="text-xs text-muted">{t(`aiAgents.agents.${s.agent_key}.name`)}</span>
              <StatusBadge status={s.status} label={t(`aiWorkflows.stepStatus.${s.status}`)} />
              {s.attempts > 1 && <span className="text-xs text-muted">{t('aiWorkflows.detail.attempts', { n: s.attempts })}</span>}
              {stepDurationMs(s) !== null && <span className="text-xs text-muted tabular-nums">{t('aiWorkflowsP9.duration', { value: formatDuration(stepDurationMs(s)) })}</span>}
              {(creditsByStep.get(s.id) ?? 0) > 0 && <span className="text-xs text-muted tabular-nums">{t('aiWorkflowsP9.stepCredits', { credits: creditsByStep.get(s.id) ?? 0 })}</span>}
              {(tokensByStep.get(s.id) ?? 0) > 0 && <span className="text-xs text-muted tabular-nums">{t('aiWorkflowsP10.tokens', { n: tokensByStep.get(s.id) ?? 0 })}</span>}
              {progressDone(s) !== null && <span className="text-xs text-flow tabular-nums">{t('aiWorkflowsP9.progress', { done: progressDone(s) ?? 0 })}</span>}
              {s.error_code && <span className="text-xs text-danger">{codeMessage(s.error_code, t)}</span>}
            </div>
            <StepOutput step={s} orgId={orgId} workflowId={workflow.id} isAdmin={isAdmin} />
            <ReviewBadges output={s.output} />
          </li>
        ))}
      </ol>
      {workflow.report && <p className="text-xs text-muted">{t('aiWorkflows.detail.guarantees')}</p>}
    </div>
  )
}
