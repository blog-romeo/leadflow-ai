import type { ToolRecorder } from './tools'
import type {
  AgentConfig,
  AgentKey,
  ApprovalRecord,
  CostWrite,
  EvidenceWrite,
  RunStatus,
  StepAction,
  StepRecord,
  StepStatus,
  WorkflowRecord,
  WorkflowStatus,
  WorkflowTemplate,
} from './types'

/**
 * Persistenza del motore multi-agent. Implementazione Supabase (service role, dopo i controlli di
 * autorizzazione) in produzione, in memoria nei test. Ogni metodo riceve l'organizzazione o legge
 * record che la contengono: nessuna query senza tenant.
 */
export interface WorkflowCreate {
  org: string
  template: WorkflowTemplate
  objective: string | null
  params: Record<string, unknown>
  idempotencyKey: string
  budgetCredits: number
  maxRuntimeSeconds: number
  createdBy: string
  steps: { position: number; agentKey: AgentKey; action: StepAction; dependsOn: number[]; requiresApproval: boolean; maxAttempts: number; timeoutSeconds: number; input: Record<string, unknown> }[]
}

export interface WorkflowPatch {
  status?: WorkflowStatus
  creditsUsed?: number
  costUsd?: number
  errorCode?: string | null
  report?: Record<string, unknown> | null
  startedAt?: string
  completedAt?: string
  deadlineAt?: string
  resumeCount?: number
}

export interface StepPatch {
  status?: StepStatus
  attempts?: number
  output?: Record<string, unknown> | null
  errorCode?: string | null
  startedAt?: string
  completedAt?: string | null
}

export interface RunPatch {
  status: RunStatus
  output?: Record<string, unknown> | null
  errorCode?: string | null
  itemsTotal?: number
  itemsFailed?: number
  creditsUsed?: number
  tokensInput?: number
  tokensOutput?: number
  costUsd?: number | null
  model?: string | null
}

export interface FollowUpSnapshot {
  leads: {
    id: string
    company_name: string
    status: string
    contactable: boolean
    days_since_activity: number | null
    open_tasks: { id: string; kind: string; is_contact: boolean; due_at: string; title: string }[]
  }[]
  overdue_tasks: { id: string; lead_id: string; title: string; due_at: string; kind: string }[]
  stale_opportunities: { id: string; lead_id: string; title: string; days_since_update: number; lead_contactable: boolean }[]
}

export interface FollowUpTaskCreate {
  leadId: string
  kind: 'check_in' | 'opportunity_review'
  title: string
  notes: string | null
  dueAt: string
  opportunityId: string | null
  createdBy: string | null
}

export interface GrowthMetrics {
  leads_acquired: number
  leads_qualified: number
  leads_contactable: number
  leads_contacted: number
  responses: number
  appointments: number
  opportunities: number
  customers_won: number
  revenue_attributed: Record<string, number>
  won_without_value: number
  ai_cost_usd: number
  ai_cost_unpriced_jobs: number
  provider_cost_usd: number
  provider_cost_unpriced_calls: number
  cost_per_lead_usd: number | null
  by_sector: { sector: string; leads: number; contacted: number; with_appointment: number; won: number }[]
}

export interface MemoryEntry {
  category: string
  entry_key: string
  version: number
  content: Record<string, unknown>
}

export interface AgentStore extends ToolRecorder {
  // Configurazione e budget
  getAgentConfigs(org: string): Promise<AgentConfig[]>
  getCreditCosts(): Promise<Record<string, number>>
  getMonthlySpend(org: string, fromIso: string): Promise<{ credits: number; byAgent: Partial<Record<AgentKey, number>> }>

  // Workflow
  createWorkflow(row: WorkflowCreate): Promise<{ workflow: WorkflowRecord; created: boolean }>
  getWorkflow(id: string): Promise<WorkflowRecord | null>
  getSteps(org: string, workflowId: string): Promise<StepRecord[]>
  /** Acquisisce il lease (pending/running con lease scaduto) e porta lo stato a running. */
  claimWorkflow(id: string, token: string, leaseSeconds: number): Promise<WorkflowRecord | null>
  renewLease(org: string, id: string, token: string, leaseSeconds: number): Promise<boolean>
  /** Aggiorna il workflow solo se il lease appartiene al chiamante. */
  updateWorkflow(org: string, id: string, token: string, patch: WorkflowPatch): Promise<boolean>
  releaseWorkflow(org: string, id: string, token: string, patch: WorkflowPatch): Promise<void>
  isCancelRequested(org: string, id: string): Promise<boolean>
  updateStep(org: string, stepId: string, patch: StepPatch): Promise<void>
  createRun(row: { org: string; workflowId: string | null; stepId: string | null; agentKey: AgentKey; attempt: number; inputSummary: Record<string, unknown>; createdBy: string | null }): Promise<string>
  finishRun(org: string, runId: string, patch: RunPatch): Promise<void>
  createApproval(row: { org: string; workflowId: string; stepId: string; action: string; summary: Record<string, unknown>; expiresHours: number }): Promise<string>
  getApproval(org: string, id: string): Promise<ApprovalRecord | null>
  expireApprovals(): Promise<string[]>
  listResumable(limit: number): Promise<string[]>

  // Evidenze, costi, memoria, audit
  insertEvidence(org: string, rows: EvidenceWrite[]): Promise<number>
  listEvidence(org: string, subjectType: 'candidate' | 'lead', subjectId: string, limit: number): Promise<EvidenceWrite[]>
  recordCost(org: string, row: CostWrite): Promise<void>
  getMemory(org: string, categories: string[], limit: number): Promise<MemoryEntry[]>
  audit(org: string, actor: string | null, action: string, entityType: string, entityId: string | null, metadata?: Record<string, unknown>): Promise<void>

  // Job AI degli agenti (prenotano i crediti tramite i trigger di billing)
  createAiJob(row: { org: string; type: 'sales_agent'; task: 'sales_strategy'; leadId: string | null; input: Record<string, unknown>; createdBy: string | null }): Promise<string>
  finishAiJob(org: string, id: string, patch: { status: 'succeeded' | 'failed'; error?: string | null; model?: string | null; tokensInput?: number; tokensOutput?: number; costUsd?: number | null; output?: unknown }): Promise<void>
  findRecentStrategy(org: string, leadId: string, inputHash: string, sinceIso: string): Promise<Record<string, unknown> | null>

  // Letture di dominio
  listCandidatesBySearch(org: string, searchId: string, limit: number): Promise<string[]>
  sectorHistory(org: string): Promise<Record<string, { won: number; lost: number }>>
  followUpSnapshot(org: string, opts: { staleDays: number; opportunityStaleDays: number; limit: number }): Promise<FollowUpSnapshot>
  createFollowUpTasks(org: string, rows: FollowUpTaskCreate[]): Promise<{ created: string[]; skipped: number }>
  blockFollowUpTasks(org: string, ids: string[], reason: string): Promise<number>
  growthMetrics(org: string, fromIso: string, toIso: string): Promise<GrowthMetrics>
  updateLeadScore(org: string, leadId: string, score: { score: number; priority: string; basis: 'rules' | 'ai'; breakdown: unknown }): Promise<boolean>
}
