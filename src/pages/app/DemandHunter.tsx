import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowRight, Briefcase, Crosshair, PlugZap, RotateCcw, Search, Square, Target, UserPlus } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { apiFetch } from '../../lib/api'
import { cn } from '../../lib/cn'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Field } from '../../components/ui/Field'
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { Stepper, type Step } from '../../features/demand-hunter/Stepper'
import { ModeBanner } from '../../features/demand-hunter/ModeBanner'
import { AreaTree } from '../../features/demand-hunter/AreaTree'
import { BudgetConfirm } from '../../features/demand-hunter/BudgetConfirm'
import { CombosTable, LiveMonitor } from '../../features/demand-hunter/LiveMonitor'
import { LeadCard } from '../../features/demand-hunter/LeadCard'
import { LearningPanel } from '../../features/demand-hunter/LearningPanel'
import { dhErrorMessage } from '../../features/demand-hunter/errors'
import {
  TERMINAL,
  type AreasResponse,
  type CrmResponse,
  type EstimateResponse,
  type Goal,
  type JobViewResponse,
  type LearningResponse,
  type StatusResponse,
  type Verdict,
} from '../../features/demand-hunter/types'

type Notice = { tone: 'ok' | 'danger' | 'signal'; text: string } | null
const POLL_MS = 2500

/**
 * Demand Hunter: integrazione di BuyerML «La caccia». Quattro passaggi: obiettivo → mercato → ricerca con
 * conferma del budget → risultati e apprendimento. Ogni dato arriva dalle API del gateway; se il servizio non
 * è collegato la pagina lo dice e non mostra nulla di inventato.
 */
export default function DemandHunter() {
  const { t, formatDate } = useI18n()
  const { currentOrg } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const [params, setParams] = useSearchParams()
  const jobId = params.get('job')

  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>(jobId ? 4 : 1)
  const [reached, setReached] = useState<Step>(jobId ? 4 : 1)
  const [goal, setGoal] = useState<Goal>('clienti')
  const [notice, setNotice] = useState<Notice>(null)

  const [areas, setAreas] = useState<AreasResponse | null>(null)
  const [areasError, setAreasError] = useState<string | null>(null)
  const [seed, setSeed] = useState('')
  const [expandEst, setExpandEst] = useState<EstimateResponse | null>(null)
  const [busy, setBusy] = useState(false)

  const [budget, setBudget] = useState(10)
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null)

  const [view, setView] = useState<JobViewResponse | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)
  const [learning, setLearning] = useState<LearningResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const go = (s: Step) => {
    setStep(s)
    setReached((r) => (s > r ? s : r))
    setNotice(null)
  }

  // ── stato del servizio e limiti ──────────────────────────────────────────
  const loadStatus = useCallback(async () => {
    if (!orgId) return
    setStatusError(null)
    try {
      setStatus(await apiFetch<StatusResponse>(`/api/demand-hunter/status?organization_id=${orgId}`))
    } catch (err) {
      setStatusError(dhErrorMessage(err, t))
    }
  }, [orgId, t])
  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const ready = Boolean(status?.configured && status.service.reachable)
  const mode = status?.service.mode ?? 'simulated'
  const maxBudget = Math.max(1, Math.min(status?.usage.max_budget_per_hunt ?? 50, status?.service.max_budget_per_hunt ?? 100))

  // ── passaggio 2: albero delle aree ───────────────────────────────────────
  const loadAreas = useCallback(async () => {
    setAreasError(null)
    try {
      setAreas(await apiFetch<AreasResponse>(`/api/demand-hunter/areas?organization_id=${orgId}&goal=${goal}`))
    } catch (err) {
      setAreasError(dhErrorMessage(err, t))
    }
  }, [orgId, goal, t])
  useEffect(() => {
    if (step === 2 && ready) void loadAreas()
  }, [step, ready, loadAreas])

  const askExpand = async () => {
    if (!seed.trim()) return
    setBusy(true)
    setNotice(null)
    try {
      setExpandEst(await apiFetch<EstimateResponse>('/api/demand-hunter/estimate', { method: 'POST', body: { organization_id: orgId, action: 'expand', goal, label: seed.trim() } }))
    } catch (err) {
      setNotice({ tone: 'danger', text: dhErrorMessage(err, t) })
    } finally {
      setBusy(false)
    }
  }
  const confirmExpand = async () => {
    if (!expandEst?.confirm_token) return
    setBusy(true)
    try {
      const r = await apiFetch<{ added: unknown[] }>('/api/demand-hunter/start', { method: 'POST', body: { organization_id: orgId, action: 'expand', goal, label: expandEst.subject, confirm_token: expandEst.confirm_token } })
      setNotice({ tone: 'ok', text: t('demandHunter.market.expandDone', { n: r.added.length }) })
      setExpandEst(null)
      await Promise.all([loadAreas(), loadStatus()])
    } catch (err) {
      setNotice({ tone: 'danger', text: dhErrorMessage(err, t) })
      setExpandEst(null)
    } finally {
      setBusy(false)
    }
  }

  // ── passaggio 3: stima e avvio ───────────────────────────────────────────
  const askEstimate = async () => {
    setBusy(true)
    setNotice(null)
    setEstimate(null)
    try {
      setEstimate(await apiFetch<EstimateResponse>('/api/demand-hunter/estimate', { method: 'POST', body: { organization_id: orgId, action: 'hunt', goal, seed: seed.trim(), budget } }))
    } catch (err) {
      setNotice({ tone: 'danger', text: dhErrorMessage(err, t) })
    } finally {
      setBusy(false)
    }
  }
  const startHunt = async () => {
    if (!estimate?.confirm_token) return
    const token = estimate.confirm_token
    setBusy(true)
    // Il token è monouso: lo togliamo subito dallo stato (nessun secondo invio, nemmeno con un doppio clic).
    setEstimate({ ...estimate, confirm_token: undefined })
    try {
      const r = await apiFetch<{ job_id: string }>('/api/demand-hunter/start', { method: 'POST', body: { organization_id: orgId, action: 'hunt', goal, seed: estimate.subject, budget: estimate.paid_calls, confirm_token: token } })
      setView(null)
      setSelected(new Set())
      setParams({ job: r.job_id })
      go(4)
    } catch (err) {
      setNotice({ tone: 'danger', text: dhErrorMessage(err, t) })
      setEstimate(null)
    } finally {
      setBusy(false)
    }
  }

  // ── passaggio 4: monitoraggio in diretta ─────────────────────────────────
  const loadView = useCallback(async () => {
    if (!jobId || !orgId) return null
    try {
      const v = await apiFetch<JobViewResponse>(`/api/demand-hunter/job?organization_id=${orgId}&job_id=${jobId}`)
      setView(v)
      setViewError(null)
      if (v.session) setGoal(v.session.goal)
      return v
    } catch (err) {
      setViewError(dhErrorMessage(err, t))
      return null
    }
  }, [jobId, orgId, t])

  const loadLearning = useCallback(
    async (g: Goal) => {
      try {
        setLearning(await apiFetch<LearningResponse>(`/api/demand-hunter/learning?organization_id=${orgId}&goal=${g}`))
      } catch {
        setLearning(null)
      }
    },
    [orgId],
  )

  useEffect(() => {
    if (!jobId) return
    let stopped = false
    const tick = async () => {
      const v = await loadView()
      if (stopped) return
      if (v && TERMINAL.includes(v.job.status)) {
        void loadLearning(v.session?.goal ?? 'clienti')
        void loadStatus()
        return
      }
      timer.current = window.setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [jobId, loadView, loadLearning, loadStatus])

  const stopHunt = async () => {
    if (!jobId) return
    try {
      await apiFetch('/api/demand-hunter/stop', { method: 'POST', body: { organization_id: orgId, job_id: jobId } })
    } catch (err) {
      setNotice({ tone: 'danger', text: dhErrorMessage(err, t) })
    }
  }

  const setVerdict = async (leadId: string, verdict: Verdict | null) => {
    setFeedbackBusy(leadId)
    try {
      const r = await apiFetch<{ learning_synced: boolean }>('/api/demand-hunter/feedback', { method: 'POST', body: { organization_id: orgId, lead_id: leadId, verdict } })
      if (!r.learning_synced) setNotice({ tone: 'signal', text: t('demandHunter.results.feedbackNotSynced') })
      setView((v) => (v ? { ...v, leads: v.leads.map((l) => (l.id === leadId ? { ...l, verdict, qualified: verdict === 'sbagliato' ? false : l.qualified } : l)) } : v))
      if (verdict === 'sbagliato') setSelected((s) => new Set([...s].filter((id) => id !== leadId)))
      if (view?.session) void loadLearning(view.session.goal)
    } catch (err) {
      setNotice({ tone: 'danger', text: dhErrorMessage(err, t) })
    } finally {
      setFeedbackBusy(null)
    }
  }

  const toCrm = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<CrmResponse>('/api/demand-hunter/crm', { method: 'POST', body: { organization_id: orgId, lead_ids: [...selected] } })
      const skipped = r.results.filter((x) => x.outcome !== 'saved')
      const detail = skipped.length ? ` (${[...new Set(skipped.map((s) => t(`demandHunter.results.crmOutcome.${s.outcome}`)))].join(', ')})` : ''
      setNotice({ tone: r.saved ? 'ok' : 'signal', text: t('demandHunter.results.crmDone', { saved: r.saved, skipped: skipped.length }) + detail })
      setSelected(new Set())
      await loadView()
    } catch (err) {
      setNotice({ tone: 'danger', text: dhErrorMessage(err, t) })
    } finally {
      setBusy(false)
    }
  }

  const newHunt = () => {
    setParams({})
    setView(null)
    setEstimate(null)
    setLearning(null)
    setStep(2)
    setReached(3)
  }

  const openSession = (job: string) => {
    setParams({ job })
    setView(null)
    go(4)
  }

  const sortedLeads = useMemo(() => [...(view?.leads ?? [])].sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.score - a.score), [view])
  const running = view ? !TERMINAL.includes(view.job.status) : false

  // ── rendering ────────────────────────────────────────────────────────────
  return (
    <div>
      <PageHeader title={t('demandHunter.title')} subtitle={t('demandHunter.subtitle')} />
      {statusError && <ErrorState message={statusError} onRetry={loadStatus} />}
      {!status && !statusError && <LoadingState />}
      {status && (
        <div className="space-y-5">
          {!status.configured ? (
            <Panel>
              <EmptyState icon={PlugZap} title={t('demandHunter.notConfigured.title')} body={t('demandHunter.notConfigured.body')} />
            </Panel>
          ) : !status.service.reachable ? (
            <InlineAlert tone="danger">{t('demandHunter.notConfigured.unreachable')}</InlineAlert>
          ) : (
            <ModeBanner mode={mode} />
          )}
          <UsageStrip status={status} />

          {ready && (
            <>
              <Stepper step={step} reached={reached} onGo={go} />
              {notice && <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>}

              {step === 1 && (
                <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
                  <Panel title={t('demandHunter.goal.title')}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(['clienti', 'lavoro'] as const).map((g) => {
                        const Icon = g === 'clienti' ? Target : Briefcase
                        return (
                          <button
                            key={g}
                            type="button"
                            onClick={() => setGoal(g)}
                            aria-pressed={goal === g}
                            className={cn('rounded-[var(--radius-panel)] border p-4 text-left transition-colors', goal === g ? 'border-flow bg-flow-soft' : 'border-line hover:bg-surface-2')}
                          >
                            <Icon className={cn('mb-2 size-5', goal === g ? 'text-flow' : 'text-muted')} aria-hidden />
                            <p className="font-semibold">{t(`demandHunter.goal.${g}`)}</p>
                            <p className="mt-1 text-sm text-muted">{t(`demandHunter.goal.${g}Body`)}</p>
                          </button>
                        )
                      })}
                    </div>
                    <div className="mt-5 flex justify-end">
                      <Button onClick={() => go(2)}>
                        {t('demandHunter.goal.next')}
                        <ArrowRight className="size-4" aria-hidden />
                      </Button>
                    </div>
                  </Panel>
                  <Panel title={t('demandHunter.goal.history')}>
                    {status.sessions.length === 0 ? (
                      <p className="text-sm text-muted">{t('demandHunter.goal.historyEmpty')}</p>
                    ) : (
                      <ul className="space-y-2">
                        {status.sessions.map((s) => (
                          <li key={s.id} className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line px-3 py-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{s.seed}</p>
                              <p className="text-xs text-muted">
                                {formatDate(s.created_at)} · {t(`demandHunter.results.status.${s.status}`)} · {t('demandHunter.market.leads', { n: s.leads_found })}
                                {s.mode === 'simulated' && ` · ${t('demandHunter.results.simulatedBadge')}`}
                              </p>
                            </div>
                            <Button size="sm" variant="secondary" onClick={() => openSession(s.job_id)}>
                              {t('demandHunter.goal.open')}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Panel>
                </div>
              )}

              {step === 2 && (
                <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
                  <Panel title={t('demandHunter.market.title')}>
                    <p className="mb-4 text-sm text-muted">{t('demandHunter.market.body')}</p>
                    {areasError && <ErrorState message={areasError} onRetry={loadAreas} />}
                    {!areas && !areasError && <LoadingState label={t('demandHunter.market.loading')} />}
                    {areas && <AreaTree root={areas.tree} selected={seed} onSelect={(l) => { setSeed(l); setExpandEst(null) }} />}
                  </Panel>
                  <div className="space-y-5">
                    <Panel title={t('demandHunter.market.orType')}>
                      <Field label={t('demandHunter.market.seedLabel')} placeholder={t('demandHunter.market.seedPlaceholder')} value={seed} maxLength={120} onChange={(e) => { setSeed(e.target.value); setExpandEst(null) }} />
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button variant="secondary" onClick={askExpand} disabled={!seed.trim()} loading={busy && !expandEst}>
                          <Search className="size-4" aria-hidden />
                          {t('demandHunter.market.expand')}
                        </Button>
                        <Button onClick={() => { setEstimate(null); go(3) }} disabled={!seed.trim()}>
                          {t('demandHunter.market.next')}
                          <ArrowRight className="size-4" aria-hidden />
                        </Button>
                      </div>
                      {expandEst && (
                        <div className="mt-4 space-y-2">
                          <p className="text-sm text-muted">{t('demandHunter.market.expandCost', { n: expandEst.paid_calls })}</p>
                          <BudgetConfirm estimate={expandEst} busy={busy} onConfirm={confirmExpand} confirmLabel={t('demandHunter.market.expandConfirm')} />
                        </div>
                      )}
                    </Panel>
                    {areas && areas.suggestions.length > 0 && (
                      <Panel title={t('demandHunter.market.suggestions')}>
                        <ul className="space-y-1.5">
                          {areas.suggestions.map((s) => (
                            <li key={s.seed}>
                              <button type="button" onClick={() => setSeed(s.seed)} className="w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left hover:bg-surface-2">
                                <span className="text-sm font-medium">{s.seed}</span>
                                <span className="block text-xs text-muted">{s.reason}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </Panel>
                    )}
                  </div>
                </div>
              )}

              {step === 3 && (
                <Panel title={t('demandHunter.launch.title')}>
                  <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
                    <div className="space-y-4">
                      <Field label={t('demandHunter.market.seedLabel')} value={seed} maxLength={120} onChange={(e) => { setSeed(e.target.value); setEstimate(null) }} />
                      <div className="space-y-1.5">
                        <label htmlFor="dh-budget" className="flex justify-between text-sm font-medium">
                          <span>{t('demandHunter.launch.budget')}</span>
                          <span className="tabular-nums">{budget}</span>
                        </label>
                        <input
                          id="dh-budget"
                          type="range"
                          min={1}
                          max={maxBudget}
                          value={Math.min(budget, maxBudget)}
                          onChange={(e) => { setBudget(Number(e.target.value)); setEstimate(null) }}
                          className="w-full accent-[var(--color-flow)]"
                        />
                        <p className="text-xs text-muted">{t('demandHunter.launch.budgetHint')}</p>
                      </div>
                      <Button variant="secondary" onClick={askEstimate} disabled={!seed.trim()} loading={busy && !estimate}>
                        {t('demandHunter.launch.estimate')}
                      </Button>
                    </div>
                    <div className="space-y-4">
                      {estimate && (
                        <>
                          <div className="flex flex-wrap gap-1.5">
                            {estimate.plan.combos !== undefined && <Badge tone="flow">{t('demandHunter.launch.combos', { n: estimate.plan.combos })}</Badge>}
                            {!!estimate.plan.already_done && <Badge tone="ok">{t('demandHunter.launch.already', { n: estimate.plan.already_done })}</Badge>}
                            {estimate.mode === 'simulated' && <Badge tone="signal">{t('demandHunter.mode.simulated')}</Badge>}
                          </div>
                          {estimate.plan.verbs && <ChipRow label={t('demandHunter.launch.verbs')} items={estimate.plan.verbs} />}
                          {estimate.plan.objects && <ChipRow label={t('demandHunter.launch.objects')} items={estimate.plan.objects} />}
                          {estimate.plan.cost && <p className="text-xs text-muted">{estimate.plan.cost}</p>}
                          <BudgetConfirm key={estimate.confirm_token ?? 'used'} estimate={estimate} busy={busy} onConfirm={startHunt} />
                        </>
                      )}
                    </div>
                  </div>
                </Panel>
              )}

              {step === 4 && (
                <div className="space-y-5">
                  {!jobId && <EmptyState icon={Crosshair} title={t('demandHunter.results.leadsEmpty')} />}
                  {viewError && <ErrorState message={viewError} onRetry={loadView} />}
                  {jobId && !view && !viewError && <LoadingState />}
                  {view && (
                    <>
                      <Panel
                        title={`${running ? t('demandHunter.results.title') : t('demandHunter.results.titleDone')} · ${view.session?.seed ?? ''}`}
                        action={
                          <div className="flex items-center gap-2">
                            <Badge tone={running ? 'flow' : view.job.status === 'completed' ? 'ok' : 'danger'}>{t(`demandHunter.results.status.${view.job.status}`)}</Badge>
                            {view.job.mode === 'simulated' && <Badge tone="signal">{t('demandHunter.results.simulatedBadge')}</Badge>}
                            {running ? (
                              <Button size="sm" variant="secondary" onClick={stopHunt}>
                                <Square className="size-3.5" aria-hidden />
                                {t('demandHunter.results.stop')}
                              </Button>
                            ) : (
                              <Button size="sm" variant="secondary" onClick={newHunt}>
                                <RotateCcw className="size-3.5" aria-hidden />
                                {t('demandHunter.results.newHunt')}
                              </Button>
                            )}
                          </div>
                        }
                      >
                        {!view.service_reachable && <div className="mb-3"><InlineAlert tone="signal">{t('demandHunter.notConfigured.unreachable')}</InlineAlert></div>}
                        <LiveMonitor view={view} />
                      </Panel>

                      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
                        <Panel
                          title={`${t('demandHunter.results.leadsTitle')} (${view.leads.length})`}
                          action={
                            <Button size="sm" onClick={toCrm} disabled={!selected.size} loading={busy}>
                              <UserPlus className="size-3.5" aria-hidden />
                              {t('demandHunter.results.toCrm')}
                              {selected.size > 0 && ` · ${selected.size}`}
                            </Button>
                          }
                        >
                          <p className="mb-3 text-xs text-muted">{t('demandHunter.results.manualContact')}</p>
                          {sortedLeads.length === 0 ? (
                            <p className="text-sm text-muted">{t('demandHunter.results.leadsEmpty')}</p>
                          ) : (
                            <div className="space-y-3">
                              {sortedLeads.map((l) => (
                                <LeadCard
                                  key={l.id}
                                  lead={l}
                                  selected={selected.has(l.id)}
                                  busy={feedbackBusy === l.id}
                                  onToggle={() => setSelected((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n })}
                                  onVerdict={(v) => setVerdict(l.id, v)}
                                />
                              ))}
                            </div>
                          )}
                        </Panel>
                        <div className="space-y-5">
                          <Panel title={t('demandHunter.learning.title')}>{learning ? <LearningPanel data={learning} /> : running ? <p className="text-sm text-muted">{t('demandHunter.results.title')}…</p> : <LoadingState />}</Panel>
                          {view.combos.length > 0 && (
                            <Panel title={`${t('demandHunter.results.combosTitle')} (${view.session?.combos_total ?? view.combos.length})`}>
                              <CombosTable combos={view.combos} />
                            </Panel>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function UsageStrip({ status }: { status: StatusResponse }) {
  const { t } = useI18n()
  const u = status.usage
  if (!u.enabled) return <InlineAlert tone="signal">{t('demandHunter.usage.disabled')}</InlineAlert>
  const pct = u.monthly_paid_calls ? Math.min(100, Math.round((u.used / u.monthly_paid_calls) * 100)) : 0
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3 text-sm">
      <span className="font-semibold">{t('demandHunter.usage.title')}</span>
      <div className="flex min-w-48 flex-1 items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div className={cn('h-full rounded-full', pct > 85 ? 'bg-danger' : 'bg-flow')} style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 text-muted">{t('demandHunter.usage.used', { used: u.used, limit: u.monthly_paid_calls })}</span>
      </div>
      <span className="text-muted">{t('demandHunter.usage.perHunt', { n: u.max_budget_per_hunt })}</span>
    </div>
  )
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <span key={i} className="rounded-full border border-line px-2 py-0.5 text-xs">
            {i}
          </span>
        ))}
      </div>
    </div>
  )
}
