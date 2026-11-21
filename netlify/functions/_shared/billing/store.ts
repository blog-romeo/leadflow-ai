import type { PlanRow } from './mapping'

/** Accesso ai dati di billing usato dai servizi (service role, dopo i controlli di autorizzazione). */
export type ClaimResult = 'claimed' | 'duplicate' | 'in_progress'

export interface CurrentStripeSubscription {
  stripe_subscription_id: string
  status: string
  plan_code: string | null
  cancel_at_period_end: boolean
}

export interface BillingStore {
  listPlans(): Promise<PlanRow[]>
  getCustomer(org: string): Promise<{ stripe_customer_id: string; livemode: boolean } | null>
  /** Collega il customer all'org; restituisce quello effettivamente collegato (il primo vince). */
  linkCustomer(org: string, customerId: string, livemode: boolean): Promise<string>
  findOrgByCustomer(customerId: string): Promise<string | null>
  getOrganizationName(org: string): Promise<string | null>
  getCurrentStripeSubscription(org: string): Promise<CurrentStripeSubscription | null>

  claimEvent(eventId: string, type: string, livemode: boolean, createdAt: Date): Promise<ClaimResult>
  finishEvent(eventId: string, status: 'processed' | 'failed' | 'ignored', error?: string | null, org?: string | null, objectId?: string | null): Promise<void>
  applySubscription(payload: Record<string, unknown>): Promise<{ applied: boolean; reason?: string; status?: string; plan?: string | null }>
  upsertInvoice(payload: Record<string, unknown>): Promise<{ applied: boolean; reason?: string }>
  audit(org: string | null, actor: string | null, action: string, metadata?: Record<string, unknown>): Promise<void>

  // ─── Rivenditori (White Label) ───────────────────────────────────────────
  listResellerPlans(): Promise<ResellerPlanRow[]>
  getResellerBilling(resellerId: string): Promise<ResellerBillingRow | null>
  linkResellerCustomer(resellerId: string, customerId: string, livemode: boolean): Promise<string>
  findResellerByCustomer(customerId: string): Promise<string | null>
  applyResellerSubscription(payload: Record<string, unknown>): Promise<{ applied: boolean; reason?: string }>
  upsertResellerInvoice(payload: Record<string, unknown>): Promise<{ applied: boolean; reason?: string }>
}

export interface ResellerPlanRow {
  code: string
  name: string
  setup_fee_cents: number
  monthly_price_cents: number
  stripe_monthly_price_id: string | null
  stripe_setup_price_id: string | null
  is_active: boolean
}

export interface ResellerBillingRow {
  id: string
  name: string
  plan_code: string
  status: 'active' | 'suspended'
  stripe_customer_id: string | null
  stripe_customer_livemode: boolean | null
  had_stripe_subscription: boolean
  current: { source: 'stripe' | 'external'; status: string; stripe_subscription_id: string | null } | null
}

/** Controllo funzionalità e quote lato server (RPC del database). */
export type Feature =
  | 'lead_finder'
  | 'ai_analyzer'
  | 'ai_sales_agent'
  | 'campaign_manager'
  | 'export'
  | 'automations'
  | 'advanced_analytics'
  | 'crm_advanced'
  | 'priority_support'

export interface FeatureDecision {
  allowed: boolean
  reason: string
  plan_code?: string | null
  status?: string | null
}

export interface LeadQuotaDecision {
  enforced: boolean
  allowed: boolean
  reason?: string | null
  used?: number
  limit?: number
  remaining?: number
}

export interface LeadCountResult {
  enforced: boolean
  counted: number
  already_counted: number
  over_quota_refs: string[]
  remaining?: number
  limit?: number
  used?: number
  reason?: string
}

export interface BillingGate {
  canUseFeature(org: string, feature: Feature): Promise<FeatureDecision>
  leadQuota(org: string): Promise<LeadQuotaDecision>
  countNewLeads(org: string, user: string | null, refs: string[], metadata?: Record<string, unknown>): Promise<LeadCountResult>
  recordProviderCall(org: string, user: string | null, provider: string, idempotencyKey: string): Promise<void>
}
