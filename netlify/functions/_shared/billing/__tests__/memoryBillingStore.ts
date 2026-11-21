import type { PlanRow } from '../mapping'
import type { BillingStore, ClaimResult, CurrentStripeSubscription, ResellerBillingRow, ResellerPlanRow } from '../store'

/**
 * Store in memoria SOLO per i test: riproduce la semantica delle funzioni SQL
 * (claim idempotente degli eventi, guardia stripe_synced_at, customer ↔ org).
 * La stessa semantica è verificata sul database reale da supabase/tests/rls_tests_billing.sql.
 */
export const TEST_PLANS: PlanRow[] = [
  { code: 'starter', name: 'Starter', price_cents: 14900, currency: 'eur', stripe_price_id: null, monthly_leads: 250, monthly_ai_credits: 500, max_users: 1, features: ['lead_finder', 'ai_analyzer', 'export'], is_active: true, sort_order: 10 },
  { code: 'business', name: 'Business', price_cents: 34900, currency: 'eur', stripe_price_id: null, monthly_leads: 1000, monthly_ai_credits: 2500, max_users: 5, features: ['lead_finder', 'ai_analyzer', 'ai_sales_agent', 'campaign_manager', 'crm_advanced', 'export'], is_active: true, sort_order: 20 },
  { code: 'enterprise', name: 'Enterprise', price_cents: 79900, currency: 'eur', stripe_price_id: null, monthly_leads: 5000, monthly_ai_credits: 10000, max_users: 20, features: ['lead_finder', 'ai_analyzer', 'ai_sales_agent', 'campaign_manager', 'crm_advanced', 'export', 'automations', 'advanced_analytics', 'priority_support'], is_active: true, sort_order: 30 },
]

export const TEST_RESELLER_PLANS: ResellerPlanRow[] = [
  { code: 'agency', name: 'Agency', setup_fee_cents: 299000, monthly_price_cents: 39900, stripe_monthly_price_id: null, stripe_setup_price_id: null, is_active: true },
  { code: 'premium', name: 'Premium', setup_fee_cents: 599000, monthly_price_cents: 79900, stripe_monthly_price_id: null, stripe_setup_price_id: null, is_active: true },
]

interface EventRow { status: 'processing' | 'processed' | 'failed' | 'ignored'; attempts: number; error: string | null; org: string | null }

export function createMemoryBillingStore(plans: PlanRow[] = TEST_PLANS) {
  const customers = new Map<string, { stripe_customer_id: string; livemode: boolean }>()
  const orgNames = new Map<string, string>()
  const subs = new Map<string, Record<string, unknown>>()
  const invoices = new Map<string, Record<string, unknown>>()
  const events = new Map<string, EventRow>()
  const audits: { org: string | null; actor: string | null; action: string; metadata: Record<string, unknown> }[] = []
  let applyCalls = 0
  const resellers = new Map<string, ResellerBillingRow>()
  const resellerSubs = new Map<string, Record<string, unknown>>()
  const resellerInvoices = new Map<string, Record<string, unknown>>()

  const store: BillingStore = {
    async listPlans() {
      return plans.map((p) => ({ ...p }))
    },
    async getCustomer(org) {
      return customers.get(org) ?? null
    },
    async linkCustomer(org, customerId, livemode) {
      if (!customers.has(org)) customers.set(org, { stripe_customer_id: customerId, livemode })
      return customers.get(org)!.stripe_customer_id
    },
    async findOrgByCustomer(customerId) {
      for (const [org, c] of customers) if (c.stripe_customer_id === customerId) return org
      return null
    },
    async getOrganizationName(org) {
      return orgNames.get(org) ?? null
    },
    async getCurrentStripeSubscription(org) {
      const rows = [...subs.values()].filter((s) => s.organization_id === org && !['canceled', 'incomplete_expired'].includes(String(s.status)))
      const r = rows.at(-1)
      return r ? ({ stripe_subscription_id: r.stripe_subscription_id, status: r.status, plan_code: r.plan_code, cancel_at_period_end: r.cancel_at_period_end } as CurrentStripeSubscription) : null
    },
    async claimEvent(eventId): Promise<ClaimResult> {
      const e = events.get(eventId)
      if (!e) {
        events.set(eventId, { status: 'processing', attempts: 1, error: null, org: null })
        return 'claimed'
      }
      if (e.status === 'processed' || e.status === 'ignored') return 'duplicate'
      if (e.status === 'processing') return 'in_progress'
      e.status = 'processing'
      e.attempts++
      return 'claimed'
    },
    async finishEvent(eventId, status, error = null, org = null) {
      const e = events.get(eventId)!
      e.status = status
      e.error = error
      e.org = org ?? e.org
    },
    async applySubscription(p) {
      applyCalls++
      const org = String(p.organization_id)
      if (customers.get(org)?.stripe_customer_id !== p.stripe_customer_id) throw new Error('customer_org_mismatch')
      const prev = subs.get(String(p.stripe_subscription_id))
      if (prev && prev.organization_id !== org) throw new Error('subscription_org_mismatch')
      if (prev && String(prev.stripe_synced_at) > String(p.stripe_synced_at)) return { applied: false, reason: 'stale_state' }
      subs.set(String(p.stripe_subscription_id), { ...p })
      return { applied: true, status: String(p.status), plan: (p.plan_code as string | null) ?? null }
    },
    async upsertInvoice(p) {
      const org = String(p.organization_id)
      if (customers.get(org)?.stripe_customer_id !== p.stripe_customer_id) throw new Error('customer_org_mismatch')
      const prev = invoices.get(String(p.stripe_invoice_id))
      if (prev && String(prev.stripe_synced_at) > String(p.stripe_synced_at)) return { applied: false, reason: 'stale_state' }
      invoices.set(String(p.stripe_invoice_id), { ...p })
      return { applied: true }
    },
    async audit(org, actor, action, metadata = {}) {
      audits.push({ org, actor, action, metadata })
    },
    async listResellerPlans() {
      return TEST_RESELLER_PLANS.map((p) => ({ ...p }))
    },
    async getResellerBilling(id) {
      const r = resellers.get(id)
      if (!r) return null
      const rows = [...resellerSubs.values()].filter((s) => s.reseller_id === id)
      const live = rows.find((s) => ['active', 'trialing', 'past_due'].includes(String(s.status)))
      return { ...r, had_stripe_subscription: r.had_stripe_subscription || rows.length > 0, current: live ? { source: 'stripe', status: String(live.status), stripe_subscription_id: String(live.stripe_subscription_id) } : r.current }
    },
    async linkResellerCustomer(id, customerId, livemode) {
      const r = resellers.get(id)!
      if (!r.stripe_customer_id) Object.assign(r, { stripe_customer_id: customerId, stripe_customer_livemode: livemode })
      return r.stripe_customer_id!
    },
    async findResellerByCustomer(customerId) {
      for (const [id, r] of resellers) if (r.stripe_customer_id === customerId) return id
      return null
    },
    async applyResellerSubscription(p) {
      const r = resellers.get(String(p.reseller_id))
      if (r?.stripe_customer_id !== p.stripe_customer_id) throw new Error('customer_reseller_mismatch')
      const prev = resellerSubs.get(String(p.stripe_subscription_id))
      if (prev && String(prev.stripe_synced_at) > String(p.stripe_synced_at)) return { applied: false, reason: 'stale_state' }
      resellerSubs.set(String(p.stripe_subscription_id), { ...p })
      return { applied: true }
    },
    async upsertResellerInvoice(p) {
      const r = resellers.get(String(p.reseller_id))
      if (r?.stripe_customer_id !== p.stripe_customer_id) throw new Error('customer_reseller_mismatch')
      resellerInvoices.set(String(p.stripe_invoice_id), { ...p })
      return { applied: true }
    },
  }
  return { store, customers, orgNames, subs, invoices, events, audits, resellers, resellerSubs, resellerInvoices, applyCount: () => applyCalls }
}
