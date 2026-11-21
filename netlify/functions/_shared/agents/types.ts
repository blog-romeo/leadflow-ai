/**
 * Tipi condivisi del motore multi-agent (Prompt 8).
 * Gli stati coincidono con i vincoli CHECK della migrazione 0012.
 */
export type AgentKey = 'orchestrator' | 'discovery' | 'research' | 'scoring' | 'strategy' | 'follow_up' | 'growth_analyst'
export const AGENT_KEYS: AgentKey[] = ['orchestrator', 'discovery', 'research', 'scoring', 'strategy', 'follow_up', 'growth_analyst']

export type WorkflowStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'partial' | 'failed' | 'cancelled'
export const TERMINAL_STATUSES: WorkflowStatus[] = ['completed', 'partial', 'failed', 'cancelled']
export type StepStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'skipped' | 'failed' | 'cancelled'
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'timed_out'
export type WorkflowTemplate = 'prospecting' | 'follow_up_review' | 'growth_report'
export type ModelTier = 'economy' | 'standard' | 'advanced'

export type StepAction =
  | 'discover'
  | 'research'
  | 'score'
  | 'crm.save_leads'
  | 'strategy'
  | 'follow_up.analyze'
  | 'follow_up.apply'
  | 'growth.analyze'

export interface WorkflowRecord {
  id: string
  organizationId: string
  template: WorkflowTemplate
  objective: string | null
  params: Record<string, unknown>
  status: WorkflowStatus
  budgetCredits: number
  creditsUsed: number
  costUsd: number
  maxRuntimeSeconds: number
  deadlineAt: string | null
  cancelRequestedAt: string | null
  createdBy: string | null
  resumeCount: number
  startedAt: string | null
  errorCode: string | null
  report: Record<string, unknown> | null
  createdAt: string
}

export interface StepRecord {
  id: string
  workflowId: string
  organizationId: string
  position: number
  agentKey: AgentKey
  action: StepAction
  dependsOn: number[]
  requiresApproval: boolean
  status: StepStatus
  attempts: number
  maxAttempts: number
  timeoutSeconds: number
  input: Record<string, unknown>
  output: Record<string, unknown> | null
  errorCode: string | null
}

export interface AgentConfig {
  agentKey: AgentKey
  enabled: boolean
  modelTier: ModelTier
  monthlyCreditBudget: number | null
  maxCreditsPerRun: number | null
  config: Record<string, number>
}

export interface ApprovalRecord {
  id: string
  organizationId: string
  workflowId: string
  stepId: string
  action: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  decidedBy: string | null
  expiresAt: string
  /** Riepilogo approvato (fonte autorevole: il database, non l'output del passo). */
  summary: Record<string, unknown>
}

export type EvidenceKind = 'fact' | 'inference' | 'unknown'
export type EvidenceCategory = 'profile' | 'sector' | 'products_services' | 'digital_presence' | 'signal' | 'opportunity' | 'fit' | 'missing'
export interface EvidenceWrite {
  workflowId: string | null
  runId: string | null
  subjectType: 'candidate' | 'lead'
  subjectId: string
  category: EvidenceCategory
  kind: EvidenceKind
  statement: string
  evidence: string | null
  sourceType: 'provider' | 'website' | 'crm' | 'ai' | 'none'
  sourceUrl: string | null
  observedAt: string | null
  rationale: string | null
}

export interface CostWrite {
  workflowId: string | null
  runId: string | null
  agentKey: AgentKey
  kind: 'ai_tokens' | 'provider_call'
  aiJobId: string | null
  model: string | null
  tokensInput: number
  tokensOutput: number
  credits: number
  costUsd: number | null
  cacheHit: boolean
}
