import type { DhAction, DhMode, Goal, JobStatus, Reading, Verdict } from './types'

/** Persistenza del Demand Hunter (Supabase in produzione, in memoria nei test). Sempre filtrata per organizzazione. */
export interface UsageSummary {
  enabled: boolean
  monthly_paid_calls: number
  max_budget_per_hunt: number
  used: number
  remaining: number
}

export interface JobRow {
  id: string
  organizationId: string
  kind: DhAction
  status: JobStatus
  confirmationId: string
  serviceJobId: string | null
  mode: DhMode
  params: Record<string, unknown>
  progress: Record<string, unknown>
  reservedCalls: number
  spentSearches: number
  spentAutocomplete: number
  usageSettled: boolean
  errorCode: string | null
  createdBy: string | null
  createdAt: string
}

export interface SessionRow {
  id: string
  organizationId: string
  jobId: string
  goal: Goal
  seed: string
  budget: number
  status: JobStatus
  mode: DhMode
  combosTotal: number
  leadsFound: number
  events: unknown[]
  verbs: unknown[]
  objects: unknown[]
  createdAt: string
  endedAt: string | null
}

export interface LeadWrite {
  sessionId: string | null
  url: string
  urlHash: string
  textHash: string
  text: string
  goal: Goal
  score: number
  stage: string | null
  demand: string | null
  leadClass: string | null
  taxonomyNode: string | null
  technology: string[]
  query: string | null
  verb: string | null
  object: string | null
  simulated: boolean
  reading: Reading | null
}

export interface LeadRow extends Omit<LeadWrite, 'reading'> {
  id: string
  organizationId: string
  status: 'new' | 'transferred' | 'dismissed'
  crmLeadId: string | null
  foundAt: string
  reading: Reading | null
  verdict: Verdict | null
}

export interface ComboWrite {
  query: string
  verb: string
  object: string
  origin: string
  status: string
  results: number
  leads: number
  priority: number
}

export interface ConceptWrite {
  goal: Goal
  label: string
  norm: string
  parentNorm: string
  rel: 'variante' | 'correlato'
  jobId: string
}

export interface LearningStatWrite {
  goal: Goal
  dimension: 'verbs' | 'objects' | 'patterns' | 'verb_patterns'
  key: string
  searches: number
  posts: number
  leads: number
  confirmed: number
  wrong: number
  rate: number
  score: number
}

export interface CrmLeadWrite {
  sourceId: string
  externalId: string
  dedupKey: string
  companyName: string
  industry: string | null
  notes: string
  score: number
  priority: 'high' | 'medium' | 'low'
  scoreExplanation: string
  createdBy: string
}

export interface DemandHunterStore {
  checkRateLimit(org: string, user: string, bucket: string): Promise<{ allowed: boolean; retry_after?: number }>
  usageSummary(org: string): Promise<UsageSummary>

  createConfirmation(row: { org: string; user: string; action: DhAction; actionKey: string; paidCalls: number; tokenHash: string; expiresAt: string }): Promise<void>
  consumeConfirmation(org: string, user: string, tokenHash: string, action: DhAction, actionKey: string): Promise<{ ok: boolean; confirmationId?: string; paidCalls?: number }>
  reserve(org: string, user: string, jobId: string, calls: number, mode: DhMode): Promise<{ allowed: boolean; reason?: string; used?: number; limit?: number; remaining?: number }>
  settle(org: string, jobId: string, spent: number): Promise<{ released: number }>

  createJob(row: { org: string; kind: DhAction; confirmationId: string; mode: DhMode; params: Record<string, unknown>; reservedCalls: number; createdBy: string }): Promise<JobRow>
  updateJob(org: string, id: string, patch: Partial<Pick<JobRow, 'status' | 'serviceJobId' | 'progress' | 'spentSearches' | 'spentAutocomplete' | 'errorCode' | 'reservedCalls'>> & { startedAt?: string; finishedAt?: string; syncedAt?: string }): Promise<void>
  getJob(org: string, id: string): Promise<JobRow | null>
  listActiveJobs(limit: number): Promise<JobRow[]>

  createSession(row: { org: string; jobId: string; goal: Goal; seed: string; budget: number; mode: DhMode; createdBy: string }): Promise<SessionRow>
  updateSession(org: string, id: string, patch: Partial<Pick<SessionRow, 'status' | 'combosTotal' | 'leadsFound' | 'events' | 'verbs' | 'objects'>> & { endedAt?: string }): Promise<void>
  getSessionByJob(org: string, jobId: string): Promise<SessionRow | null>
  listSessions(org: string, limit: number): Promise<SessionRow[]>

  upsertCombinations(org: string, sessionId: string, rows: ComboWrite[]): Promise<void>
  listCombinations(org: string, sessionId: string, limit: number): Promise<ComboWrite[]>
  /** Inserisce i lead nuovi (dedup per URL e per testo nella stessa organizzazione); restituisce quanti erano nuovi. */
  upsertLeads(org: string, rows: LeadWrite[]): Promise<{ inserted: number; duplicates: number }>
  listSessionLeads(org: string, sessionId: string, limit: number): Promise<LeadRow[]>
  getLeads(org: string, ids: string[]): Promise<LeadRow[]>
  setFeedback(org: string, leadId: string, verdict: Verdict | null, user: string): Promise<void>
  markTransferred(org: string, leadId: string, crmLeadId: string): Promise<void>

  insertConcepts(org: string, rows: ConceptWrite[]): Promise<void>
  replaceLearningStats(org: string, goal: Goal, rows: LearningStatWrite[]): Promise<void>
  listLearningStats(org: string, goal: Goal): Promise<LearningStatWrite[]>

  ensureCrmSource(org: string, user: string): Promise<string>
  insertCrmLead(org: string, lead: CrmLeadWrite): Promise<{ ok: true; id: string } | { ok: false; reason: 'duplicate' | 'suppressed' }>

  audit(org: string, actor: string, action: string, entityType: string, entityId: string | null, metadata?: Record<string, unknown>): Promise<void>
}
