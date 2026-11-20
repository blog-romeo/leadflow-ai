import type { AnalysisResult } from './analysis/schema'
import type { ExistingCandidate } from './dedup'
import type { CriterionScore } from './scoring'
import type { IcpProfile, Priority, ProviderId } from './types'

/**
 * Persistenza del Lead Finder. L'implementazione Supabase (service role) è usata
 * in produzione; i test usano un'implementazione in memoria con lo stesso contratto.
 * Ogni metodo riceve l'organizzazione esplicitamente: nessuna query senza tenant.
 */
export interface QuotaResult {
  allowed: boolean
  used: number
  limit: number
  remaining: number
}

export interface CandidateWrite {
  provider: ProviderId
  externalId: string
  searchId: string
  sourceId?: string | null
  canStoreContent: boolean
  canExport: boolean
  canSaveToCrm: boolean
  attribution: string | null
  sourceUrl: string | null
  dedupKey: string | null
  acquiredAt: string
  content: {
    companyName: string | null
    sector: string | null
    categoryTags: string[]
    address: string | null
    city: string | null
    region: string | null
    postalCode: string | null
    country: string | null
    website: string | null
    phone: string | null
  } | null
  score: { score: number; priority: Priority; basis: 'rules' | 'ai'; breakdown: CriterionScore[] } | null
  /** Se true non sovrascrive il punteggio esistente (già calcolato con AI). */
  keepExistingScore: boolean
  isNew: boolean
}

export interface CandidateRecord {
  id: string
  organizationId: string
  provider: ProviderId
  externalId: string
  searchId: string | null
  sourceId: string | null
  status: 'new' | 'saved' | 'excluded'
  leadId: string | null
  canStoreContent: boolean
  canExport: boolean
  canSaveToCrm: boolean
  companyName: string | null
  sector: string | null
  categoryTags: string[]
  address: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  website: string | null
  phone: string | null
  sourceUrl: string | null
  attribution: string | null
  dedupKey: string | null
  score: number | null
  priority: Priority | null
  scoreBasis: 'rules' | 'ai' | null
  scoreBreakdown: CriterionScore[] | null
  analysis: AnalysisResult | null
  lastAnalyzedAt: string | null
  acquiredAt: string
}

export interface LeadWrite {
  sourceId: string
  provider: ProviderId
  externalId: string
  dedupKey: string | null
  companyName: string
  website: string | null
  phone: string | null
  industry: string | null
  city: string | null
  region: string | null
  country: string | null
  notes: string | null
  score: number | null
  priority: Priority | null
  scoreBasis: 'rules' | 'ai' | null
  scoreBreakdown: CriterionScore[] | null
  scoreExplanation: string | null
  acquiredAt: string
  lastAnalyzedAt: string | null
  createdBy: string
}

export interface AiJobRecord {
  id: string
  organizationId: string
  candidateId: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  input: Record<string, unknown>
  createdBy: string | null
}

export interface SearchPatch {
  stage?: 'querying_provider' | 'normalizing' | 'deduplicating' | 'scoring' | 'saving' | 'done' | 'failed'
  status?: 'running' | 'completed' | 'failed'
  results_count?: number
  new_count?: number
  duplicate_count?: number
  excluded_count?: number
  error_code?: string | null
  completed_at?: string
}

export interface LeadFinderStore {
  checkRateLimit(org: string, user: string, bucket: string): Promise<{ allowed: boolean; retry_after?: number }>
  consumeUsage(org: string, user: string, event: 'lead_search' | 'lead_result' | 'ai_analysis' | 'ai_tokens', qty: number, metadata?: Record<string, unknown>): Promise<QuotaResult>
  countInflightAnalyses(org: string): Promise<number>
  getProfile(org: string): Promise<IcpProfile>

  createSearch(row: { id: string; org: string; provider: ProviderId; params: Record<string, unknown>; createdBy: string }): Promise<void>
  updateSearch(org: string, id: string, patch: SearchPatch): Promise<void>

  findCandidatesByExternalIds(org: string, provider: ProviderId, externalIds: string[]): Promise<ExistingCandidate[]>
  findCrmKeys(org: string, provider: ProviderId, externalIds: string[], dedupKeys: string[]): Promise<Set<string>>
  writeCandidates(org: string, rows: CandidateWrite[]): Promise<Map<string, string>>
  getCandidates(org: string, ids: string[]): Promise<CandidateRecord[]>
  listExportableCandidates(org: string, searchId: string | null, limit: number): Promise<CandidateRecord[]>
  updateCandidate(org: string, id: string, patch: Partial<{ status: 'new' | 'saved' | 'excluded'; leadId: string | null; excludedReason: string | null; excludedAt: string | null; excludedBy: string | null; analysis: AnalysisResult; lastAnalyzedAt: string; score: CandidateWrite['score'] }>): Promise<void>

  ensureProviderSource(org: string, provider: ProviderId, meta: { name: string; licenseNote: string; sourceUrl: string | null; createdBy: string }): Promise<string>
  createImportSource(org: string, meta: { name: string; description: string | null; legalBasis: string; acquiredAt: string; createdBy: string }): Promise<string>
  insertLead(org: string, lead: LeadWrite): Promise<{ ok: true; id: string } | { ok: false; reason: 'duplicate' | 'suppressed' }>
  insertLeadAnalysis(org: string, leadId: string, analysis: AnalysisResult, jobId: string | null): Promise<void>

  createAiJob(row: { org: string; candidateId: string; input: Record<string, unknown>; createdBy: string }): Promise<string>
  getAiJob(id: string): Promise<AiJobRecord | null>
  updateAiJob(org: string, id: string, patch: Partial<{ status: AiJobRecord['status']; output: unknown; error: string | null; model: string | null; tokensInput: number; tokensOutput: number; costUsd: number | null; startedAt: string; completedAt: string; input: Record<string, unknown> }>): Promise<void>

  audit(org: string, actor: string, action: string, entityType: string, entityId: string | null, metadata?: Record<string, unknown>): Promise<void>
}
