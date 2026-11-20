import type { LeadRaw, SalesProfile } from './context'
import type { QuotaResult } from '../lead-finder/store'
import type { Warning } from './postcheck'

/**
 * Persistenza del Sales Agent. Implementazione Supabase (service role) in produzione,
 * in memoria nei test. Ogni metodo riceve l'organizzazione: nessuna query senza tenant.
 */
export type SalesTask = 'intelligence' | 'messages' | 'proposal' | 'follow_up_suggestion' | 'copilot' | 'campaign_content' | 'inbound_analysis'

export interface SalesJob {
  id: string
  organizationId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  task: SalesTask
  leadId: string | null
  input: Record<string, unknown>
  createdBy: string | null
}

export interface FollowUpTaskRow {
  id: string
  lead_id: string
  kind: 'check_in' | 'second_contact' | 'opportunity_review' | 'custom'
  title: string
  notes: string | null
  due_at: string
  status: 'open' | 'done' | 'dismissed' | 'blocked'
}

export interface CopilotSnapshot {
  generated_at: string
  by_stage: Record<string, number>
  leads: {
    id: string
    company_name: string
    industry: string | null
    city: string | null
    stage: string
    score: number | null
    priority: string | null
    contactable: boolean
    days_since_activity: number | null
    has_business_analysis: boolean
  }[]
  due_follow_ups: { lead_id: string; title: string; due_at: string; overdue: boolean }[]
  open_opportunities: { lead_id: string; title: string; service_name: string | null; value_amount: number | null; currency: string }[]
}

export interface DraftWrite {
  leadId: string
  channel: 'email' | 'linkedin' | 'whatsapp' | 'phone_script' | 'follow_up'
  variant: 'professional' | 'direct' | 'consultative'
  generationId: string
  subject: string | null
  body: string
  factsUsed: { fact: string; source: string; verified: boolean }[]
  warnings: Warning[]
  aiJobId: string
  followUpTaskId: string | null
  createdBy: string | null
}

export interface ProposalWrite {
  leadId: string
  title: string
  variant: 'professional' | 'direct' | 'consultative'
  language: 'it' | 'en'
  content: Record<string, unknown>
  factsUsed: { fact: string; source: string; verified: boolean }[]
  warnings: Warning[]
  aiJobId: string
  createdBy: string | null
}

export interface JobPatch {
  status?: SalesJob['status']
  output?: unknown
  error?: string | null
  model?: string | null
  tokensInput?: number
  tokensOutput?: number
  costUsd?: number | null
  startedAt?: string
  completedAt?: string
}

export interface SalesStore {
  checkRateLimit(org: string, user: string, bucket: string): Promise<{ allowed: boolean; retry_after?: number }>
  consumeUsage(org: string, user: string, event: 'ai_generation' | 'ai_tokens', qty: number, metadata?: Record<string, unknown>): Promise<QuotaResult>
  countInflight(org: string): Promise<number>
  getProfile(org: string): Promise<SalesProfile>
  getLead(org: string, leadId: string): Promise<LeadRaw | null>
  getFollowUpTask(org: string, id: string): Promise<FollowUpTaskRow | null>
  getCopilotSnapshot(org: string): Promise<CopilotSnapshot>
  getConversation(org: string, id: string): Promise<{ id: string; user_id: string; lead_id: string | null; archived_at: string | null } | null>
  getConversationMessages(org: string, conversationId: string, limit: number): Promise<{ id: string; role: 'user' | 'assistant'; content: string }[]>
  createConversation(org: string, userId: string, title: string, leadId: string | null): Promise<string>
  insertUserMessage(org: string, conversationId: string, content: string): Promise<string>
  createJob(row: { org: string; task: SalesTask; leadId: string | null; input: Record<string, unknown>; createdBy: string }): Promise<string>
  getJob(id: string): Promise<SalesJob | null>
  updateJob(org: string, id: string, patch: JobPatch): Promise<void>
  insertDrafts(org: string, rows: DraftWrite[]): Promise<string[]>
  insertProposal(org: string, row: ProposalWrite): Promise<string>
  insertIntelligence(org: string, leadId: string, data: Record<string, unknown>, jobId: string, model: string): Promise<string>
  setFollowUpSuggestion(org: string, taskId: string, suggestion: Record<string, unknown>): Promise<void>
  insertAssistantMessage(org: string, conversationId: string, row: { content: string; structured: unknown; jobId: string; model: string; tokensInput: number; tokensOutput: number }): Promise<string>
  logActivity(org: string, leadId: string, actor: string | null, subject: string, metadata: Record<string, unknown>): Promise<void>
  getCampaignForContent(org: string, campaignId: string, position: number): Promise<CampaignContentContext | null>
  saveStepVariants(org: string, stepId: string, variants: unknown[], warnings: Warning[], jobId: string): Promise<void>
  getInbound(org: string, id: string): Promise<InboundRow | null>
  saveInboundAnalysis(org: string, id: string, a: { classification: string; summary: string; suggested_reply: string | null; needs_human: boolean; jobId: string }): Promise<void>
}

export interface CampaignContentContext {
  campaign: { id: string; name: string; status: string; goal: string; service_name: string | null; language: 'it' | 'en'; channel: string; call_to_action: string | null; description: string | null }
  step: { id: string; position: number; kind: string; day_offset: number }
  audience: { recipients: number; with_contact_name: number; industries: { name: string; count: number }[]; countries: { name: string; count: number }[]; cities: { name: string; count: number }[] }
}

export interface InboundRow {
  id: string
  lead_id: string | null
  from_email: string
  subject: string | null
  body_text: string | null
  received_at: string
  original: { subject: string; body_text: string } | null
}
