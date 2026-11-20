import type { SenderIdentity } from './compose'

/** Accesso ai dati del Campaign Manager (implementazioni: Supabase service role e memoria per i test). */
export type JobKind = 'run_step' | 'send_message' | 'run_action' | 'ingest_inbound' | 'analyze_inbound' | 'generate_content'

export interface AutomationJob {
  id: string
  organization_id: string
  kind: JobKind
  idempotency_key: string
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
  campaign_id: string | null
  workflow_id: string | null
}

export type BeginSend =
  | {
      ok: true
      resume: boolean
      idempotency_key: string
      kind: 'campaign' | 'reply' | 'test'
      lead_id: string | null
      campaign_id: string | null
      basis: string | null
      language: 'it' | 'en'
      source_name: string | null
      to_email: string
      subject: string
      body_text: string
      from_name: string
      from_email: string
      reply_to: string | null
      account_id: string
      provider: 'resend' | 'gmail' | 'microsoft365'
    }
  | { ok: false; reason: string; permanent: boolean; retry_seconds?: number; detail?: unknown }

export interface StepContext {
  recipient: { id: string; organization_id: string; campaign_id: string; lead_id: string; status: string }
  step: { id: string; kind: 'email' | 'ai_review' | 'follow_up_email' | 'opportunity_review'; position: number; day_offset: number }
  campaign: {
    status: string
    name: string
    timezone: string
    send_hour_start: number
    send_hour_end: number
    weekdays_only: boolean
    activated_by: string | null
    language: 'it' | 'en'
  }
}

export interface AccountRow {
  id: string
  organization_id: string
  provider: 'resend' | 'gmail' | 'microsoft365'
  status: 'pending' | 'connected' | 'error' | 'revoked'
  from_email: string
  sending_domain: string
  provider_domain_id: string | null
  webhook_configured: boolean
}

export interface AccountSecrets {
  api_key_ciphertext: string | null
  webhook_secret_ciphertext: string | null
}

export interface PendingEvent {
  id: number
  organization_id: string
  type: string
  lead_id: string | null
  campaign_id: string | null
  entity_type: string
  entity_id: string
  payload: Record<string, unknown>
}

export interface WorkflowRow {
  id: string
  organization_id: string
  name: string
  trigger: string
  conditions: Record<string, unknown>
  actions: { type: string; [k: string]: unknown }[]
  approved_by: string | null
}

export interface LeadBrief {
  id: string
  company_name: string
  status: string
  contact_status: string
  score: number | null
  industry: string | null
  country: string | null
  email: string | null
}

export interface InboundWrite {
  organization_id: string
  account_id: string
  provider_message_id: string
  lead_id: string | null
  recipient_id: string | null
  outbound_message_id: string | null
  from_email: string
  subject: string | null
  body_text: string | null
  received_at: string
}

export interface CampaignStore {
  scheduleDueSteps(limit: number): Promise<number>
  claimJobs(worker: string, limit: number, leaseSeconds: number): Promise<AutomationJob[]>
  finishJob(id: string, outcome: 'succeeded' | 'retry' | 'cancelled' | 'dead', error?: string | null, retrySeconds?: number | null): Promise<void>
  deferJob(id: string, seconds: number): Promise<void>
  enqueueJob(row: { org: string; kind: JobKind; key: string; payload: Record<string, unknown>; campaignId?: string | null; workflowId?: string | null; maxAttempts?: number }): Promise<string | null>
  countDueJobs(): Promise<number>

  getStepContext(recipientId: string, stepId: string): Promise<StepContext | null>
  prepareStepMessage(recipientId: string, stepId: string): Promise<{ id: string; status: string }>
  beginSend(messageId: string): Promise<BeginSend>
  finishSend(messageId: string, outcome: 'sent' | 'failed' | 'retry' | 'requeue' | 'unknown', providerId?: string | null, error?: string | null): Promise<void>
  advanceRecipient(recipientId: string, position: number): Promise<void>
  stopRecipient(recipientId: string, reason: string): Promise<void>

  getAccount(org: string | null, accountId: string): Promise<AccountRow | null>
  getAccountSecrets(accountId: string): Promise<AccountSecrets | null>
  setAccountStatus(accountId: string, patch: { status?: AccountRow['status']; last_error?: string | null; webhook_configured?: boolean }): Promise<void>
  getSenderIdentity(org: string): Promise<SenderIdentity | null>

  createTask(row: {
    org: string
    leadId: string
    kind: 'check_in' | 'second_contact' | 'opportunity_review' | 'custom'
    title: string
    notes: string | null
    dueAt: string
    source: 'campaign' | 'automation'
    recipientId?: string | null
    jobId?: string | null
    assignedTo?: string | null
  }): Promise<string | null>
  notify(org: string, userId: string | null, title: string, body: string | null, link: string | null): Promise<void>
  logActivity(org: string, leadId: string, subject: string, metadata: Record<string, unknown>): Promise<void>
  updateLeadStatus(org: string, leadId: string, status: string): Promise<void>
  getLead(org: string, leadId: string): Promise<LeadBrief | null>

  fetchPendingEvents(limit: number): Promise<PendingEvent[]>
  markEventsProcessed(ids: number[]): Promise<void>
  runningWorkflows(org: string, trigger: string): Promise<WorkflowRow[]>
  recordWorkflowRun(id: string, error: string | null): Promise<void>
  getWorkflow(id: string): Promise<WorkflowRow & { status: string } | null>

  findLeadByEmail(org: string, email: string): Promise<LeadBrief | null>
  latestOutboundTo(accountId: string, email: string): Promise<{ id: string; recipient_id: string | null; lead_id: string | null } | null>
  insertInbound(row: InboundWrite): Promise<{ id: string; duplicate: boolean }>
  createOutbound(row: {
    org: string
    kind: 'reply' | 'test'
    accountId: string
    leadId: string | null
    inReplyTo: string | null
    to: string
    subject: string
    body: string
    idempotencyKey: string
    confirmedBy: string
  }): Promise<{ id: string; duplicate: boolean }>
  applyDeliveryEvent(accountId: string, eventId: string, type: string, providerMessageId: string, occurredAt: string, detail: Record<string, unknown>): Promise<void>
  registerUnsubscribe(messageId: string): Promise<boolean>
}

/** Operazioni sugli account di comunicazione (solo endpoint admin). */
export interface AccountsDb {
  insertAccount(row: {
    organization_id: string
    provider: 'resend'
    label: string
    from_name: string
    from_email: string
    reply_to: string | null
    sending_domain: string
    daily_limit: number
    connected_by: string
  }): Promise<string>
  updateAccount(org: string, id: string, patch: Record<string, unknown>): Promise<void>
  getAccountFull(org: string, id: string): Promise<(AccountRow & { domain_status: string; dns_records: unknown; label: string }) | null>
  upsertSecrets(accountId: string, org: string, patch: { api_key_ciphertext?: string | null; webhook_secret_ciphertext?: string | null }): Promise<void>
  deleteSecrets(accountId: string): Promise<void>
  memberEmails(org: string): Promise<string[]>
}
