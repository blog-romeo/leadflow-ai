/**
 * SOLO TEST: store in memoria che replica i vincoli del database
 * (unicità per org/provider/id esterno, dedup dei lead, quote, rate limit, isolamento per org).
 */
import { randomUUID } from 'node:crypto'
import type { AiJobRecord, CandidateRecord, CandidateWrite, LeadFinderStore, LeadWrite } from '../store'
import type { AnalysisResult } from '../analysis/schema'
import { DEFAULT_WEIGHTS, type IcpProfile, type ProviderId } from '../types'
import { crmKey } from '../dedup'

export interface MemoryState {
  quotas: Record<string, { monthly_searches: number; monthly_results: number; monthly_ai_analyses: number; requests_per_minute: number }>
  usage: { org: string; user: string; event: string; qty: number; at: number }[]
  profiles: Record<string, IcpProfile>
  searches: Map<string, { org: string; provider: ProviderId; status: string; stage: string; error_code?: string | null; [k: string]: unknown }>
  candidates: CandidateRecord[]
  leads: (LeadWrite & { id: string; org: string })[]
  sources: { id: string; org: string; provider: ProviderId; type: string; legalBasis?: string }[]
  analyses: { org: string; leadId: string; analysis: AnalysisResult }[]
  jobs: (AiJobRecord & { output?: unknown; error?: string | null })[]
  audit: { org: string; action: string }[]
}

export function createMemoryStore(init: Partial<MemoryState> = {}) {
  const s: MemoryState = {
    quotas: {},
    usage: [],
    profiles: {},
    searches: new Map(),
    candidates: [],
    leads: [],
    sources: [],
    analyses: [],
    jobs: [],
    audit: [],
    ...init,
  }
  const quota = (org: string) => s.quotas[org] ?? { monthly_searches: 50, monthly_results: 1000, monthly_ai_analyses: 100, requests_per_minute: 20 }
  const limits = { lead_search: 'monthly_searches', lead_result: 'monthly_results', ai_analysis: 'monthly_ai_analyses' } as const

  const store: LeadFinderStore = {
    async checkRateLimit(org, user, bucket) {
      const ev = `rate:${bucket}`
      const recent = s.usage.filter((u) => u.user === user && u.event === ev && Date.now() - u.at < 60_000)
      if (recent.length >= quota(org).requests_per_minute) return { allowed: false, retry_after: 60 }
      s.usage.push({ org, user, event: ev, qty: 1, at: Date.now() })
      return { allowed: true }
    },
    async consumeUsage(org, user, event, qty) {
      if (event === 'ai_tokens') {
        if (qty > 0) s.usage.push({ org, user, event, qty, at: Date.now() })
        return { allowed: true, used: qty, limit: 1e9, remaining: 1e9 }
      }
      const limit = quota(org)[limits[event]]
      const used = s.usage.filter((u) => u.org === org && u.event === event).reduce((a, u) => a + u.qty, 0)
      if (used + qty > limit) return { allowed: false, used, limit, remaining: Math.max(limit - used, 0) }
      if (qty > 0) s.usage.push({ org, user, event, qty, at: Date.now() })
      return { allowed: true, used: used + qty, limit, remaining: limit - used - qty }
    },
    async countInflightAnalyses(org) {
      return s.jobs.filter((j) => j.organizationId === org && (j.status === 'queued' || j.status === 'running')).length
    },
    async getProfile(org) {
      return s.profiles[org] ?? { servicesDescription: null, idealCustomer: null, targetSectors: [], targetRegions: [], targetCountries: [], weights: DEFAULT_WEIGHTS }
    },
    async createSearch(row) {
      if (s.searches.has(row.id)) throw new Error('search_id_conflict')
      s.searches.set(row.id, { org: row.org, provider: row.provider, status: 'running', stage: 'querying_provider', params: row.params })
    },
    async updateSearch(org, id, patch) {
      const row = s.searches.get(id)
      if (row && row.org === org) Object.assign(row, patch)
    },
    async findCandidatesByExternalIds(org, provider, ids) {
      return s.candidates
        .filter((c) => c.organizationId === org && c.provider === provider && ids.includes(c.externalId))
        .map((c) => ({ id: c.id, externalId: c.externalId, status: c.status, leadId: c.leadId, scoreBasis: c.scoreBasis }))
    },
    async findCrmKeys(org, provider, ids, keys) {
      const out = new Set<string>()
      for (const l of s.leads.filter((l) => l.org === org)) {
        if (l.provider === provider && ids.includes(l.externalId)) out.add(crmKey.external(provider, l.externalId))
        if (l.dedupKey && keys.includes(l.dedupKey)) out.add(crmKey.dedup(l.dedupKey))
      }
      return out
    },
    async writeCandidates(org, rows: CandidateWrite[]) {
      const map = new Map<string, string>()
      for (const w of rows) {
        // Vincolo di licenza replicato dal database.
        if (!w.canStoreContent && (w.content || w.score)) throw new Error('23514 lead_candidates_license_storage')
        let c = s.candidates.find((x) => x.organizationId === org && x.provider === w.provider && x.externalId === w.externalId)
        if (!c) {
          c = {
            id: randomUUID(), organizationId: org, provider: w.provider, externalId: w.externalId, searchId: w.searchId, sourceId: w.sourceId ?? null,
            status: 'new', leadId: null, canStoreContent: w.canStoreContent, canExport: w.canExport, canSaveToCrm: w.canSaveToCrm,
            companyName: null, sector: null, categoryTags: [], address: null, city: null, region: null, postalCode: null, country: null, website: null, phone: null,
            sourceUrl: w.sourceUrl, attribution: w.attribution, dedupKey: w.dedupKey, score: null, priority: null, scoreBasis: null, scoreBreakdown: null,
            analysis: null, lastAnalyzedAt: null, acquiredAt: w.acquiredAt,
          }
          s.candidates.push(c)
        }
        c.searchId = w.searchId
        if (w.content) Object.assign(c, w.content)
        if (!w.keepExistingScore && w.score) Object.assign(c, { score: w.score.score, priority: w.score.priority, scoreBasis: w.score.basis, scoreBreakdown: w.score.breakdown })
        map.set(w.externalId, c.id)
      }
      return map
    },
    async getCandidates(org, ids) {
      return s.candidates.filter((c) => c.organizationId === org && ids.includes(c.id)).map((c) => ({ ...c }))
    },
    async listExportableCandidates(org, searchId, limit) {
      return s.candidates.filter((c) => c.organizationId === org && c.canExport && c.status !== 'excluded' && (!searchId || c.searchId === searchId)).slice(0, limit)
    },
    async updateCandidate(org, id, patch) {
      const c = s.candidates.find((x) => x.id === id && x.organizationId === org)
      if (!c) return
      if (patch.status === 'saved' && !c.canSaveToCrm) throw new Error('23514 lead_candidates_saved_requires_crm')
      if (patch.status) c.status = patch.status
      if ('leadId' in patch) c.leadId = patch.leadId ?? null
      if (patch.analysis) c.analysis = patch.analysis
      if (patch.lastAnalyzedAt) c.lastAnalyzedAt = patch.lastAnalyzedAt
      if (patch.score) Object.assign(c, { score: patch.score.score, priority: patch.score.priority, scoreBasis: patch.score.basis, scoreBreakdown: patch.score.breakdown })
    },
    async ensureProviderSource(org, provider) {
      const found = s.sources.find((x) => x.org === org && x.provider === provider && x.type === 'api')
      if (found) return found.id
      const id = randomUUID()
      s.sources.push({ id, org, provider, type: 'api' })
      return id
    },
    async createImportSource(org, meta) {
      const id = randomUUID()
      s.sources.push({ id, org, provider: 'csv_import', type: 'csv_import', legalBasis: meta.legalBasis })
      return id
    },
    async insertLead(org, lead) {
      const dup = s.leads.some(
        (l) => l.org === org && ((l.provider === lead.provider && l.externalId === lead.externalId) || (lead.dedupKey && l.dedupKey === lead.dedupKey)),
      )
      if (dup) return { ok: false, reason: 'duplicate' }
      const id = randomUUID()
      s.leads.push({ ...lead, id, org })
      return { ok: true, id }
    },
    async insertLeadAnalysis(org, leadId, analysis) {
      s.analyses.push({ org, leadId, analysis })
    },
    async createAiJob(row) {
      const id = randomUUID()
      s.jobs.push({ id, organizationId: row.org, candidateId: row.candidateId, status: 'queued', input: row.input, createdBy: row.createdBy })
      return id
    },
    async getAiJob(id) {
      const j = s.jobs.find((x) => x.id === id)
      return j ? { ...j } : null
    },
    async updateAiJob(org, id, patch) {
      const j = s.jobs.find((x) => x.id === id && x.organizationId === org)
      if (!j) return
      if (patch.status) j.status = patch.status
      if ('output' in patch) j.output = patch.output
      if ('error' in patch) j.error = patch.error
      if (patch.input) j.input = patch.input
    },
    async audit(org, _actor, action) {
      s.audit.push({ org, action })
    },
  }
  return { store, state: s }
}
