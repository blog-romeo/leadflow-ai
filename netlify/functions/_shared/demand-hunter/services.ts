import { HttpError } from '../http'
import { log } from '../log'
import {
  assertTool,
  demandHunterAgent,
  intentAnalysisAgent,
  leadQualificationAgent,
  orchestratorBudgetCheck,
  priorityOf,
  type DemandAgentKey,
  type DemandToolName,
} from './agents'
import type { ServiceClient } from './gateway'
import type { DemandHunterStore, LeadRow, LeadWrite, LearningStatWrite } from './store'
import { CONFIRMATION_TTL_MS, actionKey, newConfirmationToken, normalizeText, sha256Hex } from './tokens'
import { SERVICE_STATUS, SYSTEM_USER, TERMINAL_JOB_STATUSES, type Ctx, type DhMode, type Goal, type JobStatus, type ServiceJobView, type Verdict } from './types'
import type { EstimateInput, StartInput } from './validation'

/**
 * Servizi del Demand Hunter (gateway Netlify ↔ servizio Python BuyerML).
 *
 * Regole di spesa (sezione 8 della specifica):
 *  1. stima gratuita → token monouso legato a utente, organizzazione e azione esatta (budget compreso);
 *  2. l'avvio consuma il token (una sola volta) e PRENOTA il budget sul limite mensile dell'organizzazione;
 *  3. il servizio riceve come chiave di idempotenza l'id del job: un doppio invio non avvia due cacce;
 *  4. alla fine il conto viene chiuso: le chiamate non usate tornano disponibili.
 * Nessun messaggio viene mai inviato: il modulo trova e mostra richieste pubbliche, il contatto resta manuale.
 */
export interface BillingHooks {
  countNewLeads(org: string, user: string | null, refs: string[], metadata?: Record<string, unknown>): Promise<{ over_quota_refs: string[] }>
  recordProviderCall(org: string, user: string | null, provider: string, idempotencyKey: string): Promise<void>
}

export interface DhDeps {
  store: DemandHunterStore
  service: ServiceClient | null
  billing?: BillingHooks
  now?: () => number
}

interface ServiceStatus {
  mode: DhMode
  simulated: boolean
  search_provider_configured: boolean
  max_budget_per_hunt: number
  max_concurrent_per_org: number
  running: number
}

const nowMs = (deps: DhDeps) => (deps.now ?? Date.now)()
const iso = (deps: DhDeps) => new Date(nowMs(deps)).toISOString()

function service(deps: DhDeps): ServiceClient {
  if (!deps.service) throw new HttpError(503, 'demand_hunter_not_configured')
  return deps.service
}

/** Ogni chiamata al servizio passa dall'allowlist dell'agente che la esegue. */
function use<T>(agent: DemandAgentKey, tool: DemandToolName, fn: () => Promise<T>): Promise<T> {
  assertTool(agent, tool)
  return fn()
}

async function rateLimit(deps: DhDeps, ctx: Ctx, bucket: string) {
  const r = await deps.store.checkRateLimit(ctx.orgId, ctx.userId, bucket)
  if (!r.allowed) throw new HttpError(429, 'rate_limited', { retry_after: r.retry_after ?? 60 })
}

function subjectOf(input: EstimateInput | StartInput): string {
  return input.action === 'hunt' ? input.seed : input.label
}

// ════════════════════════════════════════════════════════════════════════════
// Stato del modulo
// ════════════════════════════════════════════════════════════════════════════
export async function status(deps: DhDeps, ctx: Ctx, configMissing: string[] = []) {
  const usage = await deps.store.usageSummary(ctx.orgId)
  const sessions = await deps.store.listSessions(ctx.orgId, 10)
  let svc: ServiceStatus | null = null
  let serviceError: string | null = deps.service ? null : 'demand_hunter_not_configured'
  if (deps.service) {
    try {
      svc = await deps.service.call<ServiceStatus>(ctx, 'GET', '/v1/status')
    } catch (err) {
      serviceError = err instanceof HttpError ? err.code : 'demand_hunter_service_error'
    }
  }
  return {
    configured: Boolean(deps.service),
    config_missing: configMissing,
    service: svc ? { reachable: true, mode: svc.mode, search_provider_configured: svc.search_provider_configured, max_budget_per_hunt: svc.max_budget_per_hunt, running: svc.running } : { reachable: false },
    service_error: serviceError,
    usage,
    sessions: sessions.map((s) => ({ id: s.id, job_id: s.jobId, goal: s.goal, seed: s.seed, budget: s.budget, status: s.status, mode: s.mode, leads_found: s.leadsFound, created_at: s.createdAt })),
  }
}

export async function areasTree(deps: DhDeps, ctx: Ctx, goal: Goal) {
  return use('market_discovery', 'service.areas.read', () => service(deps).call<{ tree: unknown; mode: DhMode }>(ctx, 'GET', `/v1/areas/${goal}`))
}

export async function suggestions(deps: DhDeps, ctx: Ctx) {
  return use('demand_hunter', 'service.hunt.plan', () => service(deps).call<{ suggestions: unknown[] }>(ctx, 'GET', '/v1/hunts/suggestions'))
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Stima (gratuita) + token monouso
// ════════════════════════════════════════════════════════════════════════════
async function planFor(deps: DhDeps, ctx: Ctx, input: EstimateInput | StartInput) {
  const svc = service(deps)
  const st = await use('orchestrator', 'dh.limits.read', () => svc.call<ServiceStatus>(ctx, 'GET', '/v1/status'))
  if (input.action === 'hunt') {
    const plan = await use('demand_hunter', 'service.hunt.plan', () =>
      svc.call<Record<string, unknown>>(ctx, 'POST', '/v1/hunts/plan', { seed: input.seed, budget: input.budget, goal: input.goal }),
    )
    return { status: st, plan, paidCalls: input.budget }
  }
  const plan = await use('market_discovery', 'service.areas.plan', () => svc.call<{ calls: number } & Record<string, unknown>>(ctx, 'POST', `/v1/areas/${input.goal}/plan`, { label: input.label }))
  return { status: st, plan, paidCalls: Math.max(1, Number(plan.calls) || 1) }
}

export interface EstimateResult {
  action: EstimateInput['action']
  goal: Goal
  subject: string
  paid_calls: number
  mode: DhMode
  plan: Record<string, unknown>
  usage: Awaited<ReturnType<DemandHunterStore['usageSummary']>>
  allowed: boolean
  reason?: string
  confirm_token?: string
  expires_at?: string
}

export async function estimate(deps: DhDeps, ctx: Ctx, input: EstimateInput): Promise<EstimateResult> {
  await rateLimit(deps, ctx, 'demand_hunter_estimate')
  const { status: st, plan, paidCalls } = await planFor(deps, ctx, input)
  const usage = await deps.store.usageSummary(ctx.orgId)
  const base: EstimateResult = { allowed: false, action: input.action, goal: input.goal, subject: subjectOf(input), paid_calls: paidCalls, mode: st.mode, plan, usage }
  if (!st.search_provider_configured) return { ...base, allowed: false, reason: 'search_provider_not_configured' }
  const check = orchestratorBudgetCheck(usage, paidCalls, st.mode)
  if (!check.allowed) return { ...base, allowed: false, reason: check.reason }
  const token = newConfirmationToken()
  const expiresAt = new Date(nowMs(deps) + CONFIRMATION_TTL_MS).toISOString()
  await deps.store.createConfirmation({
    org: ctx.orgId,
    user: ctx.userId,
    action: input.action,
    actionKey: actionKey(input.action, input.goal, subjectOf(input), paidCalls),
    paidCalls,
    tokenHash: sha256Hex(token),
    expiresAt,
  })
  return { ...base, allowed: true, confirm_token: token, expires_at: expiresAt }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Avvio con il token confermato
// ════════════════════════════════════════════════════════════════════════════
export async function start(deps: DhDeps, ctx: Ctx, input: StartInput) {
  await rateLimit(deps, ctx, 'demand_hunter_start')
  const svc = service(deps)
  const { status: st, paidCalls } = await planFor(deps, ctx, input)
  if (!st.search_provider_configured) throw new HttpError(503, 'search_provider_not_configured')
  const consumed = await use('orchestrator', 'dh.confirmations.consume', () =>
    deps.store.consumeConfirmation(ctx.orgId, ctx.userId, sha256Hex(input.confirm_token), input.action, actionKey(input.action, input.goal, subjectOf(input), paidCalls)),
  )
  // Token assente, già usato, scaduto, di un altro utente o per un budget diverso: nessuna spesa.
  if (!consumed.ok || !consumed.confirmationId) throw new HttpError(409, 'confirmation_invalid')

  const params = input.action === 'hunt' ? { goal: input.goal, seed: input.seed, budget: input.budget } : { goal: input.goal, label: input.label }
  const job = await deps.store.createJob({ org: ctx.orgId, kind: input.action, confirmationId: consumed.confirmationId, mode: st.mode, params, reservedCalls: paidCalls, createdBy: ctx.userId })
  const reservation = await deps.store.reserve(ctx.orgId, ctx.userId, job.id, paidCalls, st.mode)
  if (!reservation.allowed) {
    await deps.store.updateJob(ctx.orgId, job.id, { status: 'failed', errorCode: `limit_${reservation.reason ?? 'unknown'}`, reservedCalls: 0, finishedAt: iso(deps) })
    throw new HttpError(402, 'demand_hunter_limit_reached', { reason: reservation.reason ?? 'unknown', ...(reservation.remaining !== undefined ? { remaining: reservation.remaining } : {}) })
  }

  if (input.action === 'expand') {
    try {
      const out = await use('market_discovery', 'service.areas.expand', () =>
        svc.call<{ added: { label: string; rel: 'variante' | 'correlato' }[]; spent: { autocomplete: number }; label: string; mode: DhMode }>(
          ctx,
          'POST',
          `/v1/areas/${input.goal}/expand`,
          { label: input.label, idempotency_key: job.id },
          { timeoutMs: 9_000 },
        ),
      )
      const spent = Math.min(Number(out.spent?.autocomplete ?? 0), paidCalls)
      await deps.store.insertConcepts(
        ctx.orgId,
        (out.added ?? []).map((c) => ({ goal: input.goal, label: c.label, norm: normalizeText(c.label).slice(0, 200), parentNorm: normalizeText(out.label ?? input.label).slice(0, 200), rel: c.rel, jobId: job.id })),
      )
      await recordProviderCalls(deps, ctx, job.id, st.mode, 0, spent)
      await deps.store.updateJob(ctx.orgId, job.id, { status: 'completed', spentAutocomplete: spent, startedAt: iso(deps), finishedAt: iso(deps), syncedAt: iso(deps) })
      await deps.store.settle(ctx.orgId, job.id, spent)
      await deps.store.audit(ctx.orgId, ctx.userId, 'demand_hunter.area_expanded', 'demand_hunter_job', job.id, { goal: input.goal, calls: spent, added: out.added?.length ?? 0, mode: st.mode })
      return { job_id: job.id, mode: st.mode, added: out.added ?? [], spent }
    } catch (err) {
      await failJob(deps, ctx, job.id, null, err)
      throw err
    }
  }

  const session = await deps.store.createSession({ org: ctx.orgId, jobId: job.id, goal: input.goal, seed: input.seed, budget: input.budget, mode: st.mode, createdBy: ctx.userId })
  try {
    const res = await use('demand_hunter', 'service.hunt.start', () =>
      svc.call<{ job_id: string; status: string }>(ctx, 'POST', '/v1/hunts', { seed: input.seed, budget: input.budget, goal: input.goal, idempotency_key: job.id }, { timeoutMs: 8_000 }),
    )
    await deps.store.updateJob(ctx.orgId, job.id, { status: 'running', serviceJobId: res.job_id, startedAt: iso(deps) })
    await deps.store.updateSession(ctx.orgId, session.id, { status: 'running' })
  } catch (err) {
    if (err instanceof HttpError && err.code === 'demand_hunter_service_unreachable') {
      // Timeout o rete: il servizio potrebbe aver avviato la caccia. Il job resta in coda e la sincronizzazione
      // reinvia la STESSA chiave di idempotenza: il servizio restituisce la caccia esistente, mai una seconda.
      await deps.store.updateJob(ctx.orgId, job.id, { errorCode: 'start_unconfirmed' })
      return { job_id: job.id, session_id: session.id, mode: st.mode, pending: true }
    }
    await failJob(deps, ctx, job.id, session.id, err)
    throw err
  }
  await deps.store.audit(ctx.orgId, ctx.userId, 'demand_hunter.hunt_started', 'demand_hunter_job', job.id, { goal: input.goal, budget: input.budget, mode: st.mode })
  return { job_id: job.id, session_id: session.id, mode: st.mode }
}

async function failJob(deps: DhDeps, ctx: Ctx, jobId: string, sessionId: string | null, err: unknown) {
  const code = err instanceof HttpError ? err.code : 'internal_error'
  await deps.store.updateJob(ctx.orgId, jobId, { status: 'failed', errorCode: code.slice(0, 80), finishedAt: iso(deps) })
  if (sessionId) await deps.store.updateSession(ctx.orgId, sessionId, { status: 'failed', endedAt: iso(deps) })
  // Il servizio non ha avviato nulla (o non sappiamo cosa ha speso: in quel caso lo dirà la sincronizzazione).
  if (!(err instanceof HttpError && err.code === 'demand_hunter_service_unreachable')) await deps.store.settle(ctx.orgId, jobId, 0)
}

/** Registra le chiamate SerpApi reali nel Control Center (costi e sospensione dei provider). Le simulate no. */
async function recordProviderCalls(deps: DhDeps, ctx: Ctx, jobId: string, mode: DhMode, from: number, to: number) {
  if (mode !== 'live' || !deps.billing) return
  const user = ctx.userId === SYSTEM_USER ? null : ctx.userId
  for (let i = from; i < to; i++) await deps.billing.recordProviderCall(ctx.orgId, user, 'serpapi', `dh:${jobId}:${i}`)
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Monitoraggio in diretta: sincronizzazione del job con il servizio
// ════════════════════════════════════════════════════════════════════════════
export function leadWritesFrom(goal: Goal, sessionId: string, snapshot: ReturnType<typeof demandHunterAgent>['output'], mode: DhMode): LeadWrite[] {
  const readings = new Map(intentAnalysisAgent(snapshot.lead_list).output.map((r) => [r.url, r.reading]))
  return snapshot.lead_list.map((l) => ({
    sessionId,
    url: l.url,
    urlHash: sha256Hex(l.url.trim()),
    textHash: sha256Hex(normalizeText(l.text)),
    text: l.text.slice(0, 5000),
    goal,
    score: l.score,
    stage: l.stage || null,
    demand: ['yes', 'weak', 'no'].includes(l.demand) ? l.demand : null,
    leadClass: l.lead_class || null,
    taxonomyNode: l.node,
    technology: (l.technology ?? []).slice(0, 20),
    query: l.query?.slice(0, 400) ?? null,
    verb: l.verb ?? null,
    object: l.object ?? null,
    simulated: mode === 'simulated',
    reading: readings.get(l.url) ?? null,
  }))
}

export async function syncJob(deps: DhDeps, ctx: Ctx, jobId: string): Promise<{ status: JobStatus; reachable: boolean }> {
  const job = await deps.store.getJob(ctx.orgId, jobId)
  if (!job) throw new HttpError(404, 'not_found')
  if (job.kind !== 'hunt' || TERMINAL_JOB_STATUSES.includes(job.status) || !deps.service) return { status: job.status, reachable: Boolean(deps.service) }
  const session = await deps.store.getSessionByJob(ctx.orgId, job.id)
  if (!job.serviceJobId) {
    // Avvio non confermato (timeout): stessa chiave di idempotenza = la caccia già confermata, mai una seconda.
    if (!session) return { status: job.status, reachable: true }
    try {
      const res = await use('demand_hunter', 'service.hunt.start', () =>
        deps.service!.call<{ job_id: string }>(ctx, 'POST', '/v1/hunts', { seed: session.seed, budget: session.budget, goal: session.goal, idempotency_key: job.id }, { timeoutMs: 8_000 }),
      )
      await deps.store.updateJob(ctx.orgId, job.id, { status: 'running', serviceJobId: res.job_id, errorCode: null, startedAt: iso(deps) })
      await deps.store.updateSession(ctx.orgId, session.id, { status: 'running' })
      job.serviceJobId = res.job_id
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) {
        await failJob(deps, ctx, job.id, session.id, err)
        return { status: 'failed', reachable: true }
      }
      return { status: job.status, reachable: false }
    }
  }
  let view: ServiceJobView
  try {
    view = await use('demand_hunter', 'service.hunt.read', () => deps.service!.call<ServiceJobView>(ctx, 'GET', `/v1/hunts/${job.serviceJobId}`))
  } catch (err) {
    if (err instanceof HttpError && err.code === 'not_found') {
      // Il servizio non conosce più il job (dati persi): chiuso come interrotto, con la spesa nota.
      await finish(deps, ctx, job.id, session?.id ?? null, 'interrupted', job.spentSearches + job.spentAutocomplete, 'service_job_missing')
      return { status: 'interrupted', reachable: true }
    }
    return { status: job.status, reachable: false }
  }
  const status = SERVICE_STATUS[view.status] ?? 'running'
  let spent = job.spentSearches + job.spentAutocomplete
  if (view.hunt && session) {
    const env = demandHunterAgent(view.hunt)
    const snap = env.output
    const { inserted } = await use('demand_hunter', 'dh.leads.write', () => deps.store.upsertLeads(ctx.orgId, leadWritesFrom(session.goal, session.id, snap, job.mode)))
    await deps.store.upsertCombinations(
      ctx.orgId,
      session.id,
      snap.combos_list.slice(0, 400).map((c) => ({ query: c.query, verb: c.verb, object: c.object, origin: c.origin, status: c.status, results: c.results, leads: c.leads, priority: c.priority })),
    )
    await deps.store.updateSession(ctx.orgId, session.id, {
      status,
      combosTotal: snap.combos,
      leadsFound: snap.lead_list.length,
      events: snap.events.slice(-40),
      verbs: snap.verbs.slice(0, 20),
      objects: snap.objects.slice(0, 40),
    })
    const newSpent = Math.min(snap.spent.searches + snap.spent.autocomplete, job.reservedCalls)
    await recordProviderCalls(deps, ctx, job.id, job.mode, spent, newSpent)
    spent = newSpent
    await deps.store.updateJob(ctx.orgId, job.id, {
      status,
      spentSearches: snap.spent.searches,
      spentAutocomplete: snap.spent.autocomplete,
      progress: { by_status: snap.by_status, combos: snap.combos, leads: snap.lead_list.length, new_leads: inserted, budget: snap.budget },
      syncedAt: iso(deps),
    })
  } else {
    await deps.store.updateJob(ctx.orgId, job.id, { status, syncedAt: iso(deps) })
  }
  if (TERMINAL_JOB_STATUSES.includes(status)) await finish(deps, ctx, job.id, session?.id ?? null, status, spent, view.error)
  return { status, reachable: true }
}

async function finish(deps: DhDeps, ctx: Ctx, jobId: string, sessionId: string | null, status: JobStatus, spent: number, error: string | null) {
  await deps.store.updateJob(ctx.orgId, jobId, { status, finishedAt: iso(deps), ...(error ? { errorCode: String(error).slice(0, 80) } : {}) })
  if (sessionId) await deps.store.updateSession(ctx.orgId, sessionId, { status, endedAt: iso(deps) })
  const { released } = await deps.store.settle(ctx.orgId, jobId, spent)
  log('info', 'demand_hunter.job_finished', { status, spent, released })
}

/** Vista per l'interfaccia: sessione, combinazioni, lead con prove, giudizi e qualificazione. */
export async function jobView(deps: DhDeps, ctx: Ctx, jobId: string) {
  const synced = await syncJob(deps, ctx, jobId)
  const job = (await deps.store.getJob(ctx.orgId, jobId))!
  const session = await deps.store.getSessionByJob(ctx.orgId, jobId)
  const leads = session ? await deps.store.listSessionLeads(ctx.orgId, session.id, 300) : []
  const combos = session ? await deps.store.listCombinations(ctx.orgId, session.id, 200) : []
  const qualification = session ? new Map(leadQualificationAgent(session.goal, leads.map((l) => ({ url: l.url, score: l.score, reading: l.reading, verdict: l.verdict }))).output.map((q) => [q.url, q])) : new Map()
  return {
    service_reachable: synced.reachable,
    job: { id: job.id, kind: job.kind, status: job.status, mode: job.mode, reserved_calls: job.reservedCalls, spent: { searches: job.spentSearches, autocomplete: job.spentAutocomplete }, progress: job.progress, error_code: job.errorCode, created_at: job.createdAt },
    session: session && { id: session.id, goal: session.goal, seed: session.seed, budget: session.budget, status: session.status, combos_total: session.combosTotal, leads_found: session.leadsFound, events: session.events, verbs: session.verbs, objects: session.objects },
    combos,
    leads: leads.map((l) => leadView(l, qualification.get(l.url))),
  }
}

function leadView(l: LeadRow, q?: { priority: string; qualified: boolean; reasons: string[] }) {
  return {
    id: l.id,
    url: l.url,
    text: l.text,
    score: l.score,
    stage: l.stage,
    lead_class: l.leadClass,
    technology: l.technology,
    query: l.query,
    verb: l.verb,
    object: l.object,
    status: l.status,
    crm_lead_id: l.crmLeadId,
    simulated: l.simulated,
    verdict: l.verdict,
    reading: l.reading,
    priority: q?.priority ?? priorityOf(l.score),
    qualified: q?.qualified ?? true,
    reasons: q?.reasons ?? [],
  }
}

export async function stop(deps: DhDeps, ctx: Ctx, jobId: string) {
  const job = await deps.store.getJob(ctx.orgId, jobId)
  if (!job) throw new HttpError(404, 'not_found')
  if (TERMINAL_JOB_STATUSES.includes(job.status) || !job.serviceJobId) return { stopping: false }
  const r = await use('demand_hunter', 'service.hunt.stop', () => service(deps).call<{ stopping: boolean }>(ctx, 'POST', `/v1/hunts/${job.serviceJobId}/stop`, {}))
  await deps.store.audit(ctx.orgId, ctx.userId, 'demand_hunter.hunt_stopped', 'demand_hunter_job', job.id, {})
  return r
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Feedback e apprendimento
// ════════════════════════════════════════════════════════════════════════════
export async function setFeedback(deps: DhDeps, ctx: Ctx, leadId: string, verdict: Verdict | null) {
  await rateLimit(deps, ctx, 'demand_hunter_feedback')
  const [lead] = await deps.store.getLeads(ctx.orgId, [leadId])
  if (!lead) throw new HttpError(404, 'not_found')
  await use('learning', 'dh.feedback.write', () => deps.store.setFeedback(ctx.orgId, lead.id, verdict, ctx.userId))
  let learningSynced = false
  if (deps.service) {
    try {
      await use('learning', 'service.learning.feedback', () => deps.service!.call(ctx, 'POST', `/v1/learning/${lead.goal}/feedback`, { url: lead.url, verdict }))
      learningSynced = true
    } catch (err) {
      log('warn', 'demand_hunter.feedback_not_synced', { code: err instanceof HttpError ? err.code : 'error' })
    }
  }
  return { lead_id: lead.id, verdict, learning_synced: learningSynced }
}

type ServiceStat = { key: string; searches: number; posts: number; leads: number; confirmed: number; wrong: number; rate: number; score: number }
type ServiceLearning = Record<'verbs' | 'objects' | 'patterns' | 'verb_patterns', ServiceStat[]> & { totals: Record<string, unknown>; priors: Record<string, Record<string, number>> }

export async function learning(deps: DhDeps, ctx: Ctx, goal: Goal) {
  if (deps.service) {
    try {
      const s = await use('learning', 'service.learning.read', () => deps.service!.call<ServiceLearning>(ctx, 'GET', `/v1/learning/${goal}`))
      const rows: LearningStatWrite[] = (['verbs', 'objects', 'patterns', 'verb_patterns'] as const).flatMap((dimension) =>
        (s[dimension] ?? []).slice(0, 500).map((x) => ({ goal, dimension, key: String(x.key), searches: x.searches, posts: x.posts, leads: x.leads, confirmed: x.confirmed, wrong: x.wrong, rate: x.rate, score: x.score })),
      )
      await deps.store.replaceLearningStats(ctx.orgId, goal, rows)
      return { source: 'service' as const, totals: s.totals, priors: s.priors, verbs: s.verbs.slice(0, 20), objects: s.objects.slice(0, 30), patterns: s.patterns.slice(0, 20), verb_patterns: s.verb_patterns.slice(0, 20) }
    } catch (err) {
      if (!(err instanceof HttpError) || err.status < 500) throw err
    }
  }
  // Servizio non raggiungibile: ultime statistiche salvate (sola lettura).
  const rows = await deps.store.listLearningStats(ctx.orgId, goal)
  const pick = (d: LearningStatWrite['dimension']) => rows.filter((r) => r.dimension === d)
  return { source: 'cache' as const, totals: null, priors: null, verbs: pick('verbs'), objects: pick('objects'), patterns: pick('patterns'), verb_patterns: pick('verb_patterns') }
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Trasferimento nel CRM (azione esplicita, deduplicata)
// ════════════════════════════════════════════════════════════════════════════
export type CrmOutcome = 'saved' | 'already_transferred' | 'duplicate' | 'suppressed' | 'simulated' | 'marked_wrong' | 'over_quota' | 'not_found'

export function crmLeadFor(l: LeadRow, sourceId: string, userId: string) {
  const topic = (l.object || l.technology[0] || 'Demand Hunter').replace(/\s+/g, ' ').trim()
  const evidence = (l.reading?.evidence ?? [])
    .filter((e) => e.match)
    .slice(0, 6)
    .map((e) => `${e.signal}: «${e.match}»`)
    .join('; ')
  const notes = [
    `Richiesta pubblica individuata da Demand Hunter (${l.goal}).`,
    `Testo: ${l.text}`,
    `Fonte: ${l.url}`,
    l.query ? `Ricerca: ${l.query}` : null,
    evidence ? `Prove della classificazione: ${evidence}` : null,
    'Contatto manuale: nessun messaggio è stato inviato automaticamente.',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 10_000)
  return {
    sourceId,
    externalId: l.urlHash,
    dedupKey: `dh:${l.textHash}`,
    companyName: `Richiesta pubblica · ${topic}`.slice(0, 200),
    industry: l.taxonomyNode,
    notes,
    score: l.score,
    priority: priorityOf(l.score),
    scoreExplanation: `Punteggio delle regole BuyerML (demand.py): stadio ${l.stage ?? 'n/d'}${l.reading?.budget_declared ? ', budget dichiarato' : ''}${l.reading?.urgency === 'high' ? ', urgente' : ''}.`.slice(0, 4000),
    createdBy: userId,
  }
}

export async function transferToCrm(deps: DhDeps, ctx: Ctx, leadIds: string[]) {
  assertTool('lead_qualification', 'crm.save_leads')
  await rateLimit(deps, ctx, 'demand_hunter_crm')
  const unique = [...new Set(leadIds)]
  const leads = await deps.store.getLeads(ctx.orgId, unique)
  const byId = new Map(leads.map((l) => [l.id, l]))
  const results: { lead_id: string; outcome: CrmOutcome; crm_lead_id?: string }[] = []
  const eligible = leads.filter((l) => l.status !== 'transferred' && !l.simulated && l.verdict !== 'sbagliato')
  // Quota lead del piano (stessa regola del Lead Finder): conteggiati una sola volta per lead.
  const over = new Set(deps.billing && eligible.length ? (await deps.billing.countNewLeads(ctx.orgId, ctx.userId, eligible.map((l) => `dh:${l.id}`), { kind: 'demand_hunter' })).over_quota_refs : [])
  let sourceId: string | null = null
  for (const id of unique) {
    const l = byId.get(id)
    if (!l) { results.push({ lead_id: id, outcome: 'not_found' }); continue }
    if (l.status === 'transferred' && l.crmLeadId) { results.push({ lead_id: id, outcome: 'already_transferred', crm_lead_id: l.crmLeadId }); continue }
    // I lead simulati non entrano mai nel CRM reale.
    if (l.simulated) { results.push({ lead_id: id, outcome: 'simulated' }); continue }
    if (l.verdict === 'sbagliato') { results.push({ lead_id: id, outcome: 'marked_wrong' }); continue }
    if (over.has(`dh:${l.id}`)) { results.push({ lead_id: id, outcome: 'over_quota' }); continue }
    sourceId ??= await deps.store.ensureCrmSource(ctx.orgId, ctx.userId)
    const res = await deps.store.insertCrmLead(ctx.orgId, crmLeadFor(l, sourceId, ctx.userId))
    if (!res.ok) { results.push({ lead_id: id, outcome: res.reason }); continue }
    await deps.store.markTransferred(ctx.orgId, l.id, res.id)
    await deps.store.audit(ctx.orgId, ctx.userId, 'demand_hunter.saved_to_crm', 'lead', res.id, { demand_hunter_lead_id: l.id })
    results.push({ lead_id: id, outcome: 'saved', crm_lead_id: res.id })
  }
  return { results, saved: results.filter((r) => r.outcome === 'saved').length }
}
