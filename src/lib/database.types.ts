/**
 * Tipi del database allineati alle migrazioni in supabase/migrations.
 * Rigenerabili con: npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type PlatformRole = 'user' | 'super_admin'
export type OrgRole = 'organization_admin' | 'member'
export type LeadStatus =
  | 'new' | 'to_qualify' | 'qualified' | 'to_contact' | 'contacted' | 'in_conversation'
  | 'meeting_scheduled' | 'proposal_sent' | 'negotiation' | 'won' | 'lost' | 'not_contactable'
export const PIPELINE_STAGES: LeadStatus[] = [
  'new', 'to_qualify', 'qualified', 'to_contact', 'contacted', 'in_conversation',
  'meeting_scheduled', 'proposal_sent', 'negotiation', 'won', 'lost', 'not_contactable',
]
export type MessageChannel = 'email' | 'linkedin' | 'whatsapp' | 'phone_script' | 'follow_up'
export type MessageVariant = 'professional' | 'direct' | 'consultative'
export type DraftStatus = 'draft' | 'approved' | 'archived'
export type ProposalStatus = 'draft' | 'approved' | 'sent_manually' | 'archived'
export type FollowUpKind = 'check_in' | 'second_contact' | 'opportunity_review' | 'custom'
export type FollowUpStatus = 'open' | 'done' | 'dismissed' | 'blocked'
export type SalesTone = 'formal' | 'friendly' | 'direct' | 'consultative'
export type ContactStatus = 'active' | 'opted_out' | 'suppressed'
export type CampaignStatus = WorkflowStatus
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'
export type AiJobType = 'lead_finder' | 'business_analysis' | 'lead_scoring' | 'sales_agent' | 'follow_up'
export type AiJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type ActivityType = 'note' | 'call' | 'email' | 'meeting' | 'status_change' | 'system'
export type SubscriptionStatus =
  | 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid' | 'paused'

export type ProfileRow = {
  id: string
  email: string
  full_name: string | null
  platform_role: PlatformRole
  locale: 'it' | 'en'
  created_at: string
  updated_at: string
}
export type OrganizationRow = {
  id: string
  name: string
  slug: string
  vat_number: string | null
  country: string
  data_retention_days: number
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
export type OrganizationMemberRow = {
  organization_id: string
  user_id: string
  role: OrgRole
  created_at: string
}
export type LeadRow = {
  id: string
  organization_id: string
  source_id: string
  company_name: string
  website: string | null
  vat_number: string | null
  industry: string | null
  city: string | null
  country: string | null
  contact_name: string | null
  contact_role: string | null
  email: string | null
  phone: string | null
  status: LeadStatus
  contact_status: ContactStatus
  tags: string[]
  opted_out_at: string | null
  suppressed_at: string | null
  score: number | null
  priority: 'high' | 'medium' | 'low' | null
  score_basis: 'rules' | 'ai' | null
  score_breakdown: Json | null
  score_explanation: string | null
  stage_changed_at: string | null
  region: string | null
  provider: 'osm_overpass' | 'google_places' | 'csv_import' | null
  external_id: string | null
  acquired_at: string | null
  last_analyzed_at: string | null
  owner_id: string | null
  notes: string | null
  last_activity_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
export type LeadSourceRow = {
  id: string
  organization_id: string
  type: 'manual' | 'csv_import' | 'website_form' | 'public_registry' | 'partner' | 'api'
  name: string
  description: string | null
  legal_basis: 'legitimate_interest' | 'consent' | 'contract' | 'public_professional_data'
  source_url: string | null
  acquired_at: string
  created_by: string | null
  created_at: string
}
export type WorkflowStatus = 'draft' | 'pending_approval' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export const WORKFLOW_STATUSES: WorkflowStatus[] = ['draft', 'pending_approval', 'scheduled', 'running', 'paused', 'completed', 'failed', 'cancelled']
export type OutreachChannel = 'email' | 'linkedin' | 'whatsapp' | 'phone'
export const OUTREACH_CHANNELS: OutreachChannel[] = ['email', 'linkedin', 'whatsapp', 'phone']
export type CampaignGoal = 'meeting' | 'demo' | 'proposal' | 'awareness' | 'reactivation' | 'other'
export const CAMPAIGN_GOALS: CampaignGoal[] = ['meeting', 'demo', 'proposal', 'awareness', 'reactivation', 'other']
export type RecipientStatus = 'pending' | 'eligible' | 'excluded' | 'in_sequence' | 'stopped' | 'completed'
export type OutboundStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'delivery_delayed' | 'bounced' | 'complained' | 'failed' | 'cancelled' | 'unknown'
export type InboundClass = 'positive' | 'question' | 'neutral' | 'not_interested' | 'unsubscribe' | 'out_of_office' | 'needs_human' | 'other'
export const INBOUND_CLASSES: InboundClass[] = ['positive', 'question', 'neutral', 'not_interested', 'unsubscribe', 'out_of_office', 'needs_human', 'other']
export type AutomationTrigger = 'lead_qualified' | 'draft_approved' | 'campaign_activated' | 'message_delivered' | 'reply_received' | 'appointment_scheduled' | 'opportunity_updated' | 'opt_out_registered'
export const AUTOMATION_TRIGGERS: AutomationTrigger[] = ['lead_qualified', 'draft_approved', 'campaign_activated', 'message_delivered', 'reply_received', 'appointment_scheduled', 'opportunity_updated', 'opt_out_registered']
export type WorkflowActionType = 'create_activity' | 'notify' | 'generate_draft' | 'update_lead_status' | 'create_reminder' | 'prepare_follow_up'
export const WORKFLOW_ACTIONS: WorkflowActionType[] = ['create_activity', 'notify', 'generate_draft', 'update_lead_status', 'create_reminder', 'prepare_follow_up']

export type CampaignRow = {
  id: string
  organization_id: string
  name: string
  description: string | null
  status: CampaignStatus
  goal: CampaignGoal
  service_name: string | null
  language: 'it' | 'en'
  channel: OutreachChannel
  purpose: string
  planned_start_at: string | null
  timezone: string
  send_hour_start: number
  send_hour_end: number
  weekdays_only: boolean
  audience_filters: Record<string, unknown>
  account_id: string | null
  stop_on_appointment: boolean
  call_to_action: string | null
  content_approved_by: string | null
  content_approved_at: string | null
  activated_by: string | null
  activated_at: string | null
  activation_snapshot: Json | null
  paused_reason: string | null
  completed_at: string | null
  archived_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}
export type CampaignSequenceRow = { id: string; organization_id: string; campaign_id: string; name: string; stop_on_reply: boolean; created_at: string; updated_at: string }
export type CampaignStepRow = {
  id: string
  organization_id: string
  sequence_id: string
  position: number
  day_offset: number
  kind: 'email' | 'ai_review' | 'follow_up_email' | 'opportunity_review'
  subject: string | null
  body: string | null
  ai_variants: { variant: string; subject: string; body: string; call_to_action: string; warnings: Warning[] }[]
  ai_warnings: Warning[]
  ai_job_id: string | null
  created_at: string
  updated_at: string
}
export type Eligibility = { eligible?: boolean; basis?: string | null; country?: string; reasons?: string[]; warnings?: string[]; source_type?: string; source_basis?: string }
export type CampaignRecipientRow = {
  id: string
  organization_id: string
  campaign_id: string
  lead_id: string
  status: RecipientStatus
  eligible: boolean | null
  eligibility: Eligibility
  exclusion_reasons: string[]
  evaluated_at: string | null
  current_position: number | null
  next_step_at: string | null
  last_message_at: string | null
  stopped_reason: string | null
  stopped_at: string | null
  completed_at: string | null
  added_at: string
  updated_at: string
}
export type CommunicationAccountRow = {
  id: string
  organization_id: string
  provider: 'resend' | 'gmail' | 'microsoft365'
  label: string
  from_name: string
  from_email: string
  reply_to: string | null
  sending_domain: string
  provider_domain_id: string | null
  domain_status: string
  dns_records: { record: string; name: string; type: string; value: string; status: string; ttl?: string; priority?: number }[]
  spf_status: 'unknown' | 'pass' | 'missing' | 'fail'
  dkim_status: 'unknown' | 'pass' | 'missing' | 'fail'
  dmarc_status: 'unknown' | 'pass' | 'missing' | 'fail'
  dmarc_policy: string | null
  status: 'pending' | 'connected' | 'error' | 'revoked'
  webhook_configured: boolean
  inbound_enabled: boolean
  daily_limit: number
  per_minute_limit: number
  last_checked_at: string | null
  last_error: string | null
  connected_by: string | null
  connected_at: string | null
  revoked_by: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}
export type OutboundMessageRow = {
  id: string
  organization_id: string
  kind: 'campaign' | 'reply' | 'test'
  campaign_id: string | null
  recipient_id: string | null
  step_id: string | null
  lead_id: string | null
  account_id: string
  in_reply_to: string | null
  to_email: string
  subject: string
  body_text: string
  status: OutboundStatus
  idempotency_key: string
  provider_message_id: string | null
  attempts: number
  confirmed_by: string | null
  scheduled_at: string
  sending_started_at: string | null
  sent_at: string | null
  delivered_at: string | null
  bounced_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}
export type InboundMessageRow = {
  id: string
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
  ai_classification: InboundClass | null
  ai_summary: string | null
  ai_suggested_reply: string | null
  ai_needs_human: boolean | null
  ai_job_id: string | null
  classification: InboundClass | null
  classification_confirmed_by: string | null
  classification_confirmed_at: string | null
  handled_at: string | null
  handled_by: string | null
  created_at: string
}
export type ConsentRecordRow = {
  id: string
  organization_id: string
  lead_id: string
  channel: OutreachChannel
  purpose: string
  status: 'granted' | 'withdrawn' | 'objected'
  evidence: string
  evidence_url: string | null
  policy_version: string | null
  captured_at: string
  created_by: string | null
  created_at: string
}
export type WorkflowAction = { type: WorkflowActionType; days?: number; status?: string; title?: string; text?: string; channel?: string }
export type AutomationWorkflowRow = {
  id: string
  organization_id: string
  name: string
  trigger: AutomationTrigger
  conditions: { campaign_id?: string; min_score?: number; industry?: string; lead_statuses?: string[] }
  actions: WorkflowAction[]
  status: WorkflowStatus
  approved_by: string | null
  approved_at: string | null
  run_count: number
  last_run_at: string | null
  last_error: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}
export type AutomationJobRow = {
  id: string
  organization_id: string
  kind: string
  idempotency_key: string
  payload: Record<string, unknown>
  status: 'queued' | 'running' | 'succeeded' | 'dead' | 'cancelled'
  run_at: string
  attempts: number
  max_attempts: number
  last_error: string | null
  campaign_id: string | null
  workflow_id: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}
export type NotificationRow = { id: string; organization_id: string; user_id: string | null; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }
export type DeliveryEventRow = { id: string; organization_id: string; account_id: string; provider: string; provider_event_id: string; event_type: string; outbound_message_id: string | null; detail: Record<string, unknown>; occurred_at: string; created_at: string }
export type ActivityRow = {
  id: string
  organization_id: string
  lead_id: string | null
  type: ActivityType
  subject: string | null
  body: string | null
  occurred_at: string
  created_by: string | null
  created_at: string
}
export type AppointmentRow = {
  id: string
  organization_id: string
  lead_id: string | null
  title: string
  starts_at: string
  ends_at: string
  location: string | null
  status: AppointmentStatus
  created_by: string | null
  created_at: string
  updated_at: string
}
export type AiJobRow = {
  id: string
  organization_id: string
  type: AiJobType
  status: AiJobStatus
  input: Json
  output: Json | null
  error: string | null
  model: string | null
  tokens_input: number | null
  tokens_output: number | null
  candidate_id: string | null
  task: string | null
  lead_id: string | null
  cost_usd: number | null
  created_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}
export type LeadCandidateRow = {
  id: string
  organization_id: string
  provider: 'osm_overpass' | 'google_places' | 'csv_import'
  external_id: string
  search_id: string | null
  source_id: string | null
  company_name: string | null
  sector: string | null
  category_tags: string[]
  address: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
  website: string | null
  phone: string | null
  source_url: string | null
  attribution: string | null
  can_store_content: boolean
  can_export: boolean
  can_save_to_crm: boolean
  dedup_key: string | null
  status: 'new' | 'saved' | 'excluded'
  excluded_reason: string | null
  lead_id: string | null
  score: number | null
  priority: 'high' | 'medium' | 'low' | null
  score_basis: 'rules' | 'ai' | null
  score_breakdown: Json | null
  analysis: Json | null
  last_analyzed_at: string | null
  acquired_at: string
  last_seen_at: string
  created_at: string
  updated_at: string
}
export type LeadSearchRow = {
  id: string
  organization_id: string
  provider: 'osm_overpass' | 'google_places' | 'csv_import'
  params: Json
  status: 'running' | 'completed' | 'failed'
  stage: 'querying_provider' | 'normalizing' | 'deduplicating' | 'scoring' | 'saving' | 'done' | 'failed'
  results_count: number
  new_count: number
  duplicate_count: number
  excluded_count: number
  error_code: string | null
  created_by: string | null
  created_at: string
  completed_at: string | null
}
export type OrganizationProfileRow = {
  organization_id: string
  services_description: string | null
  ideal_customer: string | null
  target_sectors: string[]
  target_regions: string[]
  target_countries: string[]
  weight_sector: number
  weight_geography: number
  weight_icp: number
  weight_signals: number
  weight_completeness: number
  updated_by: string | null
  updated_at: string
}
export type SalesService = {
  id: string
  name: string
  description?: string | null
  price_from?: number | null
  price_to?: number | null
  price_unit?: string | null
}
export type SalesProfileRow = {
  id: string
  organization_id: string
  commercial_name: string | null
  sector: string | null
  offer_description: string | null
  services: SalesService[]
  price_range: string | null
  currency: string
  served_areas: string[]
  ideal_customer: string | null
  differentiators: string[]
  website: string | null
  language: 'it' | 'en'
  tone: SalesTone
  call_to_action: string | null
  booking_url: string | null
  commercial_terms: string | null
  follow_up_days: number[]
  sender_legal_name: string | null
  sender_address: string | null
  privacy_policy_url: string | null
  email_signature: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}
export type Warning = { code: string; detail?: string }
export type FactUsed = { fact: string; source: string; verified: boolean }
export type MessageDraftRow = {
  id: string
  organization_id: string
  lead_id: string
  channel: MessageChannel
  variant: MessageVariant
  generation_id: string
  subject: string | null
  body: string
  status: DraftStatus
  facts_used: FactUsed[]
  warnings: Warning[]
  generated_by: 'ai' | 'manual'
  ai_job_id: string | null
  follow_up_task_id: string | null
  edited_at: string | null
  approved_at: string | null
  approved_by: string | null
  archived_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}
export type ProposalContent = {
  company_presentation?: string
  opportunity?: { statement: string; basis: 'verified' | 'hypothesis'; evidence?: string }
  solution?: string
  services_included?: string[]
  benefits?: string[]
  pricing?: { currency: string; price_range?: string | null; lines: { service_id: string; name: string; price_from: number | null; price_to: number | null; price_unit: string | null }[] }
  conditions?: string
  call_to_action?: string
  assumptions?: string[]
}
export type SalesProposalRow = {
  id: string
  organization_id: string
  lead_id: string
  opportunity_id: string | null
  title: string
  status: ProposalStatus
  variant: MessageVariant
  language: 'it' | 'en'
  content: ProposalContent
  facts_used: FactUsed[]
  warnings: Warning[]
  generated_by: 'ai' | 'manual'
  ai_job_id: string | null
  version: number
  edited_at: string | null
  approved_at: string | null
  approved_by: string | null
  sent_at: string | null
  sent_by: string | null
  archived_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}
export type FollowUpTaskRow = {
  id: string
  organization_id: string
  lead_id: string
  proposal_id: string | null
  opportunity_id: string | null
  kind: FollowUpKind
  is_contact: boolean
  title: string
  notes: string | null
  due_at: string
  status: FollowUpStatus
  priority: 'high' | 'medium' | 'low'
  assigned_to: string | null
  source: 'cadence' | 'manual' | 'ai'
  blocked_reason: string | null
  ai_suggestion: { suggestion: string; reasoning: string; timing_note: string; draft_id: string | null; generated_at: string } | null
  completed_at: string | null
  completed_by: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}
export type SalesOpportunityRow = {
  id: string
  organization_id: string
  lead_id: string
  title: string
  service_name: string | null
  value_amount: number | null
  currency: string
  status: 'open' | 'won' | 'lost'
  expected_close_date: string | null
  owner_id: string | null
  notes: string | null
  closed_at: string | null
  closed_by: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}
export type AiConversationRow = {
  id: string
  organization_id: string
  user_id: string
  title: string | null
  lead_id: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}
export type AiMessageRow = {
  id: string
  organization_id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  structured: {
    facts: { statement: string; lead_ids: string[] }[]
    inferences: { statement: string; lead_ids: string[] }[]
    suggestions: { statement: string; lead_id: string | null; action: string }[]
  } | null
  ai_job_id: string | null
  model: string | null
  tokens_input: number | null
  tokens_output: number | null
  created_at: string
}
export type LeadAnalysisRow = {
  id: string
  organization_id: string
  lead_id: string
  ai_job_id: string | null
  kind: 'business_analysis' | 'sales_intelligence'
  summary: string | null
  data: Json
  model: string | null
  created_at: string
}
export type LeadActivityRow = {
  id: string
  organization_id: string
  lead_id: string
  type: ActivityType | 'proposal' | 'message_draft' | 'follow_up' | 'opportunity' | 'appointment' | 'ai'
  subject: string | null
  body: string | null
  metadata: Record<string, unknown>
  occurred_at: string
  created_by: string | null
  created_at: string
}
export type SubscriptionRow = {
  id: string
  organization_id: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan: string
  status: SubscriptionStatus
  current_period_end: string | null
  cancel_at_period_end: boolean
  created_at: string
  updated_at: string
}
export type AuditLogRow = {
  id: number
  organization_id: string | null
  actor_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  metadata: Json
  created_at: string
}

/** Piani commerciali (letti da tutti gli utenti autenticati; modificabili solo via RPC dal super admin). */
export type BillingPlanRow = {
  code: string
  name: string
  description: string | null
  price_cents: number
  currency: string
  billing_interval: 'month'
  stripe_price_id: string | null
  monthly_leads: number
  monthly_ai_credits: number
  max_users: number
  features: string[]
  is_active: boolean
  sort_order: number
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type AiCreditCostRow = {
  operation: string
  ai_task: string | null
  credits: number
  feature: string
  description: string
  updated_by: string | null
  updated_at: string
}

/**
 * Le `interface` non hanno una firma indice implicita e non soddisfano il vincolo
 * `Record<string, unknown>` di supabase-js (GenericTable): lo schema intero degradava a `never`.
 * Il tipo mappato `Plain<T>` converte qualsiasi interfaccia in un tipo oggetto equivalente.
 */
type Plain<T> = { [K in keyof T]: T[K] }
type Table<Row, Insert = Partial<Row>, Rel extends unknown[] = []> = {
  Row: Plain<Row>
  Insert: Plain<Insert>
  Update: Plain<Partial<Row>>
  Relationships: Rel
}

// ─── Prompt 6: onboarding, assistenza ─────────────────────────────────────
export type TicketStatus = 'open' | 'waiting_customer' | 'waiting_staff' | 'resolved' | 'closed'
export type TicketCategory = 'account' | 'billing' | 'lead_finder' | 'ai' | 'crm' | 'campaigns' | 'white_label' | 'privacy' | 'bug' | 'other'
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'
export interface OnboardingProgressRow {
  user_id: string
  organization_id: string | null
  step: number
  company: { sector?: string; website?: string; size?: string }
  commercial: { services?: string; ideal_customer?: string; area?: string; goal?: string }
  plan_code: string | null
  payment_deferred: boolean
  tour_completed_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}
export interface SupportTicketRow {
  id: string
  number: number
  organization_id: string
  created_by: string | null
  subject: string
  category: TicketCategory
  priority: TicketPriority
  status: TicketStatus
  customer_unread: boolean
  staff_unread: boolean
  last_activity_at: string
  created_at: string
  updated_at: string
}
export interface SupportTicketMessageRow {
  id: string
  ticket_id: string
  author_id: string | null
  author_role: 'customer' | 'staff'
  body: string
  created_at: string
}


// ─── Prompt 8: motore multi-agent ─────────────────────────────────────────
export type AiAgentKey = 'orchestrator' | 'discovery' | 'research' | 'scoring' | 'strategy' | 'follow_up' | 'growth_analyst'
export const AI_AGENT_KEYS: AiAgentKey[] = ['orchestrator', 'discovery', 'research', 'scoring', 'strategy', 'follow_up', 'growth_analyst']
export type AiWorkflowStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'partial' | 'failed' | 'cancelled'
export type AiStepStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'skipped' | 'failed' | 'cancelled'
export type AiModelTier = 'economy' | 'standard' | 'advanced'
export type AiMemoryCategory =
  | 'commercial_profile' | 'products' | 'services' | 'ideal_customer' | 'communication_preferences' | 'approved_strategies' | 'campaign_results' | 'user_feedback'
export const AI_MEMORY_CATEGORIES: AiMemoryCategory[] = ['commercial_profile', 'products', 'services', 'ideal_customer', 'communication_preferences', 'approved_strategies', 'campaign_results', 'user_feedback']
export interface AiAgentRow {
  organization_id: string
  agent_key: AiAgentKey
  enabled: boolean
  model_tier: AiModelTier
  monthly_credit_budget: number | null
  max_credits_per_run: number | null
  config: Record<string, number>
  updated_by: string | null
  created_at: string
  updated_at: string
}
export interface AiWorkflowRow {
  id: string
  organization_id: string
  template: 'prospecting' | 'follow_up_review' | 'growth_report'
  objective: string | null
  params: Json
  status: AiWorkflowStatus
  idempotency_key: string
  budget_credits: number
  credits_used: number
  cost_usd: number
  max_runtime_seconds: number
  deadline_at: string | null
  cancel_requested_at: string | null
  cancel_requested_by: string | null
  lock_token: string | null
  locked_until: string | null
  resume_count: number
  error_code: string | null
  report: Json | null
  created_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}
export interface AiWorkflowStepRow {
  id: string
  organization_id: string
  workflow_id: string
  position: number
  agent_key: AiAgentKey
  action: string
  depends_on: number[]
  requires_approval: boolean
  status: AiStepStatus
  attempts: number
  max_attempts: number
  timeout_seconds: number
  input: Json
  output: Json | null
  error_code: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}
export interface AiAgentRunRow {
  id: string
  organization_id: string
  workflow_id: string | null
  step_id: string | null
  agent_key: AiAgentKey
  attempt: number
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'timed_out'
  input_summary: Json
  output: Json | null
  error_code: string | null
  items_total: number
  items_failed: number
  credits_used: number
  tokens_input: number
  tokens_output: number
  cost_usd: number | null
  model: string | null
  created_by: string | null
  started_at: string
  completed_at: string | null
}
export interface AiAgentToolCallRow {
  id: number
  organization_id: string
  run_id: string | null
  workflow_id: string | null
  agent_key: AiAgentKey
  tool: string
  outcome: 'succeeded' | 'failed' | 'denied'
  denied_reason: string | null
  error_code: string | null
  args_summary: Json
  result_summary: Json
  duration_ms: number | null
  created_at: string
}
export interface AiAgentApprovalRow {
  id: string
  organization_id: string
  workflow_id: string
  step_id: string
  action: string
  summary: Json
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  requested_at: string
  expires_at: string
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
}
export interface AiCompanyMemoryRow {
  id: string
  organization_id: string
  category: AiMemoryCategory
  entry_key: string
  version: number
  content: Json
  status: 'active' | 'superseded'
  source: 'user' | 'agent_approved' | 'system'
  expires_at: string
  created_by: string | null
  created_at: string
}
export interface AiResearchEvidenceRow {
  id: string
  organization_id: string
  workflow_id: string | null
  run_id: string | null
  subject_type: 'candidate' | 'lead'
  subject_id: string
  category: string
  kind: 'fact' | 'inference' | 'unknown'
  statement: string
  evidence: string | null
  source_type: 'provider' | 'website' | 'crm' | 'ai' | 'none'
  source_url: string | null
  observed_at: string | null
  rationale: string | null
  created_at: string
}
export interface AiAgentCostRow {
  id: number
  organization_id: string
  workflow_id: string | null
  run_id: string | null
  agent_key: AiAgentKey
  kind: 'ai_tokens' | 'provider_call'
  ai_job_id: string | null
  model: string | null
  tokens_input: number
  tokens_output: number
  credits: number
  cost_usd: number | null
  cache_hit: boolean
  created_at: string
}

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow>
      organizations: Table<OrganizationRow>
      organization_members: Table<
        OrganizationMemberRow,
        Partial<OrganizationMemberRow>,
        [
          {
            foreignKeyName: 'organization_members_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      >
      lead_sources: Table<LeadSourceRow>
      leads: Table<LeadRow>
      campaigns: Table<CampaignRow>
      activities: Table<ActivityRow>
      appointments: Table<AppointmentRow>
      ai_jobs: Table<AiJobRow>
      subscriptions: Table<SubscriptionRow>
      audit_logs: Table<AuditLogRow>
      lead_candidates: Table<LeadCandidateRow>
      lead_searches: Table<LeadSearchRow>
      organization_profiles: Table<OrganizationProfileRow>
      sales_profiles: Table<SalesProfileRow>
      message_drafts: Table<MessageDraftRow>
      sales_proposals: Table<SalesProposalRow>
      follow_up_tasks: Table<FollowUpTaskRow>
      sales_opportunities: Table<SalesOpportunityRow>
      ai_conversations: Table<AiConversationRow>
      ai_messages: Table<AiMessageRow>
      lead_analyses: Table<LeadAnalysisRow>
      campaign_sequences: Table<CampaignSequenceRow>
      campaign_steps: Table<CampaignStepRow>
      campaign_recipients: Table<CampaignRecipientRow>
      communication_accounts: Table<CommunicationAccountRow>
      outbound_messages: Table<OutboundMessageRow>
      inbound_messages: Table<InboundMessageRow>
      consent_records: Table<ConsentRecordRow>
      automation_workflows: Table<AutomationWorkflowRow>
      automation_jobs: Table<AutomationJobRow>
      automation_events: Table<{ id: number; organization_id: string; type: AutomationTrigger; lead_id: string | null; campaign_id: string | null; entity_type: string; entity_id: string; payload: Json; created_at: string; processed_at: string | null }>
      notifications: Table<NotificationRow>
      delivery_events: Table<DeliveryEventRow>
      billing_plans: Table<BillingPlanRow>
      ai_credit_costs: Table<AiCreditCostRow>
      reseller_members: Table<{ reseller_id: string; user_id: string; role: 'reseller_admin' | 'reseller_member'; created_at: string }>
      onboarding_progress: Table<OnboardingProgressRow>
      support_tickets: Table<SupportTicketRow>
      support_ticket_messages: Table<SupportTicketMessageRow>
      ai_agents: Table<AiAgentRow>
      ai_workflows: Table<AiWorkflowRow>
      ai_workflow_steps: Table<AiWorkflowStepRow>
      ai_agent_runs: Table<AiAgentRunRow>
      ai_agent_tool_calls: Table<AiAgentToolCallRow>
      ai_agent_approvals: Table<AiAgentApprovalRow>
      ai_company_memory: Table<AiCompanyMemoryRow>
      ai_research_evidence: Table<AiResearchEvidenceRow>
      ai_agent_costs: Table<AiAgentCostRow>
    }
    Views: {
      lead_activities: { Row: LeadActivityRow; Relationships: [] }
    }
    Functions: {
      create_organization: {
        Args: { p_name: string; p_vat_number?: string | null; p_country?: string }
        Returns: OrganizationRow
      }
      sales_dashboard: {
        Args: { p_org: string; p_from: string; p_to: string }
        Returns: Json
      }
      usage_summary: {
        Args: { p_org: string }
        Returns: Json
      }
      suppress_lead: {
        Args: { p_lead_id: string; p_reason?: string }
        Returns: undefined
      }
      add_campaign_recipients: { Args: { p_campaign: string; p_filters: Json }; Returns: Json }
      evaluate_campaign_recipients: { Args: { p_campaign: string }; Returns: Json }
      campaign_readiness: { Args: { p_campaign: string }; Returns: Json }
      campaign_transition: { Args: { p_campaign: string; p_action: string; p_confirmation?: Json }; Returns: CampaignRow }
      billing_status: { Args: { p_org: string }; Returns: Json }
      invitation_preview: { Args: { p_token: string }; Returns: Json }
      accept_reseller_invitation: { Args: { p_token: string; p_vat_number?: string | null; p_country?: string }; Returns: string }
      reseller_my_resellers: { Args: Record<string, never>; Returns: Json }
      billing_can_use_feature: { Args: { p_org: string; p_feature: string }; Returns: Json }
      billing_admin_revenue: { Args: { p_days?: number }; Returns: Json }
      admin_update_billing_plan: { Args: { p_code: string; p_patch: Json }; Returns: BillingPlanRow }
      admin_update_credit_cost: { Args: { p_operation: string; p_credits: number }; Returns: AiCreditCostRow }
      campaign_metrics: {
        Args: { p_org: string; p_from: string; p_to: string; p_campaign?: string | null; p_channel?: OutreachChannel | null; p_status?: WorkflowStatus | null }
        Returns: Json
      }
      onboarding_state: { Args: Record<string, never>; Returns: Json }
      onboarding_save_company: { Args: { p_org: string; p_sector: string | null; p_website: string | null; p_size: string | null }; Returns: Json }
      onboarding_save_commercial: { Args: { p_org: string; p_services: string | null; p_ideal_customer: string | null; p_area: string | null; p_goal: string | null }; Returns: Json }
      onboarding_advance: { Args: { p_action: string; p_plan?: string | null }; Returns: Json }
      onboarding_checklist: { Args: { p_org: string }; Returns: Json }
      support_create_ticket: { Args: { p_org: string; p_subject: string; p_category: TicketCategory; p_priority: TicketPriority; p_body: string }; Returns: string }
      support_reply: { Args: { p_ticket: string; p_body: string }; Returns: string }
      support_set_status: { Args: { p_ticket: string; p_status: TicketStatus }; Returns: undefined }
      support_mark_read: { Args: { p_ticket: string }; Returns: undefined }
      org_members: { Args: { p_org: string }; Returns: Json }
      org_invitations: { Args: { p_org: string }; Returns: Json }
      org_revoke_invitation: { Args: { p_org: string; p_invitation: string }; Returns: undefined }
      org_remove_member: { Args: { p_org: string; p_user: string }; Returns: undefined }
      team_invitation_preview: { Args: { p_token: string }; Returns: Json }
      accept_team_invitation: { Args: { p_token: string }; Returns: string }
      ai_agent_configure: { Args: { p_org: string; p_agent: string; p_patch: Json }; Returns: AiAgentRow }
      ai_memory_upsert: { Args: { p_org: string; p_category: string; p_entry_key: string; p_content: Json; p_retention_days?: number }; Returns: Json }
      ai_memory_delete: { Args: { p_org: string; p_category: string; p_entry_key: string }; Returns: number }
      ai_agent_spend: { Args: { p_org: string; p_from: string }; Returns: Json }
      ai_growth_metrics: { Args: { p_org: string; p_from: string; p_to: string }; Returns: Json }
    }
    Enums: {
      platform_role: PlatformRole
      org_role: OrgRole
      lead_status: LeadStatus
      contact_status: ContactStatus
    }
    CompositeTypes: { [_ in never]: never }
  }
}
