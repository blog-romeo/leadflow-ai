/**
 * Tipi del database allineati alle migrazioni in supabase/migrations.
 * Rigenerabili con: npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type PlatformRole = 'user' | 'super_admin'
export type OrgRole = 'organization_admin' | 'member'
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost'
export type ContactStatus = 'active' | 'opted_out' | 'suppressed'
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived'
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
  opted_out_at: string | null
  suppressed_at: string | null
  score: number | null
  priority: 'high' | 'medium' | 'low' | null
  score_basis: 'rules' | 'ai' | null
  score_breakdown: Json | null
  score_explanation: string | null
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
export type CampaignRow = {
  id: string
  organization_id: string
  name: string
  description: string | null
  status: CampaignStatus
  created_by: string | null
  created_at: string
  updated_at: string
}
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

type Table<Row, Insert = Partial<Row>, Rel extends unknown[] = []> = {
  Row: Row
  Insert: Insert
  Update: Partial<Row>
  Relationships: Rel
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
    }
    Views: { [_ in never]: never }
    Functions: {
      create_organization: {
        Args: { p_name: string; p_vat_number?: string | null; p_country?: string }
        Returns: OrganizationRow
      }
      usage_summary: {
        Args: { p_org: string }
        Returns: Json
      }
      suppress_lead: {
        Args: { p_lead_id: string; p_reason?: string }
        Returns: undefined
      }
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
