import { HttpError } from '../../http'
import type { ServiceClient } from '../gateway'
import type { ComboWrite, ConceptWrite, CrmLeadWrite, DemandHunterStore, JobRow, LeadRow, LearningStatWrite, SessionRow } from '../store'
import type { Ctx, ServiceSnapshot, Verdict } from '../types'

/**
 * Store in memoria con le stesse regole del database (0018): tutto filtrato per organizzazione, token monouso
 * legati a utente/org/azione, limiti mensili sulle sole chiamate live, chiusura idempotente, dedup dei lead per
 * URL e testo, dedup del CRM. Solo dati simulati.
 */
export function memoryStore(opts: { limits?: Record<string, { monthly: number; perHunt: number; enabled?: boolean }> } = {}) {
  let seq = 0
  const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
  const confirmations: { org: string; user: string; action: string; actionKey: string; paidCalls: number; tokenHash: string; expiresAt: string; consumed: boolean; id: string }[] = []
  const usage: { org: string; job: string | null; kind: 'reserve' | 'release'; qty: number; mode: string }[] = []
  const jobs: (JobRow & { settled?: boolean })[] = []
  const sessions: SessionRow[] = []
  const combos = new Map<string, ComboWrite>()
  const leads: LeadRow[] = []
  const feedback = new Map<string, { verdict: Verdict; user: string }>()
  const concepts: (ConceptWrite & { org: string })[] = []
  const stats: (LearningStatWrite & { org: string })[] = []
  const crm: (CrmLeadWrite & { id: string; org: string })[] = []
  const audits: { org: string; action: string }[] = []
  const rate = { allowed: true }
  const limitsFor = (org: string) => opts.limits?.[org] ?? { monthly: 200, perHunt: 50, enabled: true }
  const usedLive = (org: string) => usage.filter((u) => u.org === org && u.mode === 'live').reduce((s, u) => s + u.qty, 0)

  const store: DemandHunterStore = {
    async checkRateLimit() {
      return rate.allowed ? { allowed: true } : { allowed: false, retry_after: 30 }
    },
    async usageSummary(org) {
      const l = limitsFor(org)
      const used = usedLive(org)
      return { enabled: l.enabled !== false, monthly_paid_calls: l.monthly, max_budget_per_hunt: l.perHunt, used, remaining: Math.max(l.monthly - used, 0) }
    },
    async createConfirmation(row) {
      confirmations.push({ ...row, consumed: false, id: id() })
    },
    async consumeConfirmation(org, user, tokenHash, action, actionKey) {
      const c = confirmations.find((x) => x.tokenHash === tokenHash && x.org === org && x.user === user && x.action === action && x.actionKey === actionKey && !x.consumed && x.expiresAt > new Date().toISOString())
      if (!c) return { ok: false }
      c.consumed = true
      return { ok: true, confirmationId: c.id, paidCalls: c.paidCalls }
    },
    async reserve(org, _user, jobId, calls, mode) {
      const l = limitsFor(org)
      if (l.enabled === false) return { allowed: false, reason: 'disabled' }
      if (calls > l.perHunt) return { allowed: false, reason: 'budget_per_hunt' }
      if (mode === 'live' && usedLive(org) + calls > l.monthly) return { allowed: false, reason: 'monthly_limit', remaining: Math.max(l.monthly - usedLive(org), 0) }
      usage.push({ org, job: jobId, kind: 'reserve', qty: calls, mode })
      return { allowed: true }
    },
    async settle(org, jobId, spent) {
      const j = jobs.find((x) => x.id === jobId && x.organizationId === org)
      if (!j) throw new HttpError(500, 'job not found')
      if (j.settled) return { released: 0 }
      j.settled = true
      const unused = Math.max(j.reservedCalls - Math.max(spent, 0), 0)
      if (unused > 0) usage.push({ org, job: jobId, kind: 'release', qty: -unused, mode: j.mode })
      return { released: unused }
    },
    async createJob(row) {
      if (jobs.some((j) => j.confirmationId === row.confirmationId)) throw new HttpError(409, 'duplicate_request')
      const j: JobRow = { id: id(), organizationId: row.org, kind: row.kind, status: 'queued', confirmationId: row.confirmationId, serviceJobId: null, mode: row.mode, params: row.params, progress: {}, reservedCalls: row.reservedCalls, spentSearches: 0, spentAutocomplete: 0, usageSettled: false, errorCode: null, createdBy: row.createdBy, createdAt: new Date().toISOString() }
      jobs.push(j)
      return { ...j }
    },
    async updateJob(org, jid, patch) {
      const j = jobs.find((x) => x.id === jid && x.organizationId === org)
      if (j) Object.assign(j, Object.fromEntries(Object.entries(patch).filter(([k]) => !['startedAt', 'finishedAt', 'syncedAt'].includes(k))))
    },
    async getJob(org, jid) {
      const j = jobs.find((x) => x.id === jid && x.organizationId === org)
      return j ? { ...j } : null
    },
    async listActiveJobs(limit) {
      return jobs.filter((j) => ['queued', 'running'].includes(j.status)).slice(0, limit)
    },
    async createSession(row) {
      const s: SessionRow = { id: id(), organizationId: row.org, jobId: row.jobId, goal: row.goal, seed: row.seed, budget: row.budget, status: 'queued', mode: row.mode, combosTotal: 0, leadsFound: 0, events: [], verbs: [], objects: [], createdAt: new Date().toISOString(), endedAt: null }
      sessions.push(s)
      return { ...s }
    },
    async updateSession(org, sid, patch) {
      const s = sessions.find((x) => x.id === sid && x.organizationId === org)
      if (s) Object.assign(s, patch)
    },
    async getSessionByJob(org, jobId) {
      return sessions.find((s) => s.jobId === jobId && s.organizationId === org) ?? null
    },
    async listSessions(org, limit) {
      return sessions.filter((s) => s.organizationId === org).slice(0, limit)
    },
    async upsertCombinations(_org, sid, rows) {
      for (const r of rows) combos.set(`${sid}|${r.query}`, r)
    },
    async listCombinations(_org, sid, limit) {
      return [...combos.entries()].filter(([k]) => k.startsWith(`${sid}|`)).map(([, v]) => v).slice(0, limit)
    },
    async upsertLeads(org, rows) {
      let inserted = 0
      let duplicates = 0
      for (const r of rows) {
        if (leads.some((l) => l.organizationId === org && (l.urlHash === r.urlHash || (l.goal === r.goal && l.textHash === r.textHash)))) {
          duplicates++
          continue
        }
        leads.push({ ...r, id: id(), organizationId: org, status: 'new', crmLeadId: null, foundAt: new Date().toISOString(), verdict: null })
        inserted++
      }
      return { inserted, duplicates }
    },
    async listSessionLeads(org, sid) {
      return leads.filter((l) => l.organizationId === org && l.sessionId === sid).map((l) => ({ ...l, verdict: feedback.get(l.id)?.verdict ?? null }))
    },
    async getLeads(org, ids) {
      return leads.filter((l) => l.organizationId === org && ids.includes(l.id)).map((l) => ({ ...l, verdict: feedback.get(l.id)?.verdict ?? null }))
    },
    async setFeedback(org, leadId, verdict, user) {
      if (!leads.some((l) => l.id === leadId && l.organizationId === org)) throw new HttpError(500, 'fk')
      if (verdict === null) feedback.delete(leadId)
      else feedback.set(leadId, { verdict, user })
    },
    async markTransferred(org, leadId, crmLeadId) {
      const l = leads.find((x) => x.id === leadId && x.organizationId === org)
      if (l) Object.assign(l, { status: 'transferred', crmLeadId })
    },
    async insertConcepts(org, rows) {
      for (const r of rows) if (!concepts.some((c) => c.org === org && c.goal === r.goal && c.norm === r.norm)) concepts.push({ ...r, org })
    },
    async replaceLearningStats(org, goal, rows) {
      for (let i = stats.length - 1; i >= 0; i--) if (stats[i].org === org && stats[i].goal === goal) stats.splice(i, 1)
      stats.push(...rows.map((r) => ({ ...r, org })))
    },
    async listLearningStats(org, goal) {
      return stats.filter((s) => s.org === org && s.goal === goal)
    },
    async ensureCrmSource() {
      return 'source-1'
    },
    async insertCrmLead(org, l) {
      if (crm.some((c) => c.org === org && (c.dedupKey === l.dedupKey || c.externalId === l.externalId))) return { ok: false, reason: 'duplicate' }
      const row = { ...l, id: id(), org }
      crm.push(row)
      return { ok: true, id: row.id }
    },
    async audit(org, _actor, action) {
      audits.push({ org, action })
    },
  }
  return { store, confirmations, usage, jobs, sessions, leads, feedback, concepts, stats, crm, audits, rate }
}

export const BUYER = 'Stiamo cercando uno sviluppatore Laravel per il nostro gestionale, budget 4000 euro'

export function reading(over: Partial<Record<string, unknown>> = {}) {
  return {
    author_role: 'buyer',
    demand: 'yes',
    intent_types: ['service_demand'],
    stage: 'high_intent',
    lead_score: 96,
    confidence: 0.95,
    urgency: 'high',
    budget_declared: true,
    specificity: 'medium',
    lead_class: 'cliente',
    taxonomy_path: ['it', 'software'],
    technology: ['Laravel'],
    evidence: [
      { signal: 'ask', match: 'Stiamo cercando' },
      { signal: 'budget', match: 'budget' },
    ],
    reader: 'rules',
    ...over,
  }
}

export function snapshot(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    seed: 'Laravel',
    goal: 'clienti',
    status: 'finita',
    budget: 5,
    spent: { searches: 3, autocomplete: 1 },
    combos: 60,
    by_status: { provata: 3, 'da provare': 57 },
    leads: 2,
    combos_list: [{ query: 'site:facebook.com/groups "cerco" "Laravel"', verb: 'cerco', object: 'Laravel', origin: 'seed', status: 'provata', results: 3, leads: 1, priority: 1 }],
    verbs: [{ text: 'cerco', searches: 1, results: 3, leads: 1, dropped: false, weight: 1.3 }],
    objects: [{ text: 'Laravel', searches: 1, results: 3, leads: 1, dropped: false, weight: 1.3 }],
    lead_list: [
      { url: 'https://www.facebook.com/groups/esempio-simulato/posts/1-laravel', text: BUYER, demand: 'yes', stage: 'high_intent', score: 96, intents: ['service_demand'], node: 'software', technology: ['Laravel'], lead_class: 'cliente', query: 'q1', verb: 'cerco', object: 'Laravel', found_at: '10:00:00', reading: reading() },
      // stesso testo sotto un altro URL: deduplicato
      { url: 'https://www.facebook.com/groups/esempio-simulato/posts/2-laravel', text: `  ${BUYER.toUpperCase()} `, demand: 'yes', stage: 'high_intent', score: 96, intents: [], node: 'software', technology: ['Laravel'], lead_class: 'cliente', query: 'q2', verb: 'cerco', object: 'Laravel', found_at: '10:00:01', reading: reading() },
      // lettura non valida: il lead resta, ma senza classificazione
      { url: 'https://www.facebook.com/groups/esempio-simulato/posts/3-laravel', text: 'Cerco consulente Laravel', demand: 'weak', stage: 'need', score: 55, intents: [], node: 'software', technology: [], lead_class: 'cliente', query: 'q3', verb: 'cerco', object: 'Laravel', found_at: '10:00:02', reading: { broken: true } as never },
    ],
    events: [{ at: '10:00:00', kind: 'ricerca', text: 'q1 → 3 risultati, 1 lead' }],
    mode: 'simulated',
    ...over,
  }
}

/** Servizio Python simulato: registra il contesto (org, utente) di ogni chiamata. */
export function fakeService(opts: { mode?: 'simulated' | 'live'; providerConfigured?: boolean; snapshot?: () => ServiceSnapshot; down?: boolean } = {}) {
  const calls: { ctx: Ctx; method: string; path: string; body?: unknown }[] = []
  const started = new Map<string, string>()
  const svc: ServiceClient = {
    async call<T>(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
      calls.push({ ctx, method, path, body })
      if (opts.down) throw new HttpError(503, 'demand_hunter_service_unreachable')
      const mode = opts.mode ?? 'simulated'
      if (path === '/v1/status') return { mode, simulated: mode === 'simulated', search_provider_configured: opts.providerConfigured ?? true, max_budget_per_hunt: 100, max_concurrent_per_org: 1, running: 0 } as T
      if (path === '/v1/hunts/plan') return { seed: (body as { seed: string }).seed, combos: 60, mode } as T
      if (path.endsWith('/plan')) return { calls: 2, phrases: ['x', 'cerco x'], mode } as T
      if (path === '/v1/hunts') {
        const key = (body as { idempotency_key: string }).idempotency_key
        if (!started.has(key)) started.set(key, `svc${started.size + 1}aaaaaaaa`)
        return { job_id: started.get(key), status: 'in coda' } as T
      }
      if (path.startsWith('/v1/hunts/') && method === 'GET') {
        const snap = (opts.snapshot ?? snapshot)()
        return { job_id: path.split('/')[3], status: snap.status, error: null, terminal: true, hunt: snap, mode } as T
      }
      if (path.endsWith('/expand')) return { label: 'Cybersecurity', added: [{ label: 'siem per pmi', rel: 'correlato' }], spent: { autocomplete: 2 }, mode } as T
      if (path.startsWith('/v1/learning/') && method === 'POST') return { ok: true } as T
      if (path.startsWith('/v1/learning/')) return { verbs: [{ key: 'cerco', searches: 2, posts: 3, leads: 1, confirmed: 0, wrong: 0, rate: 0.5, score: 0.4 }], objects: [], patterns: [], verb_patterns: [], totals: { searches: 2 }, priors: {} } as T
      throw new HttpError(404, 'not_found')
    },
  }
  return { svc, calls, started }
}
