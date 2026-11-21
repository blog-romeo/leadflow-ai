import type { SupabaseClient } from '@supabase/supabase-js'
import { HttpError } from '../http'
import { log } from '../log'
import { billingDbError } from './access'
import type { PlanRow } from './mapping'
import type { BillingGate, BillingStore, ClaimResult, CurrentStripeSubscription, FeatureDecision, LeadCountResult, LeadQuotaDecision, ResellerBillingRow, ResellerPlanRow } from './store'

function fail(op: string, error: { message?: string; code?: string; details?: string | null } | null): never {
  const billing = billingDbError(error)
  if (billing) throw billing
  log('error', 'billing_store.error', { op, code: error?.code })
  throw new HttpError(500, 'storage_error')
}

const PLAN_COLUMNS = 'code, name, price_cents, currency, stripe_price_id, monthly_leads, monthly_ai_credits, max_users, features, is_active, sort_order'

/** Store di billing con service role: usato SOLO dopo i controlli di autorizzazione. */
export function createBillingStore(db: SupabaseClient): BillingStore {
  return {
    async listPlans() {
      const { data, error } = await db.from('billing_plans').select(PLAN_COLUMNS).order('sort_order')
      if (error) fail('list_plans', error)
      return (data ?? []) as PlanRow[]
    },
    async getCustomer(org) {
      const { data, error } = await db.from('stripe_customers').select('stripe_customer_id, livemode').eq('organization_id', org).maybeSingle()
      if (error) fail('get_customer', error)
      return (data as { stripe_customer_id: string; livemode: boolean } | null) ?? null
    },
    async linkCustomer(org, customerId, livemode) {
      const { data, error } = await db.rpc('billing_link_customer', { p_org: org, p_customer: customerId, p_livemode: livemode })
      if (error) fail('link_customer', error)
      return data as string
    },
    async findOrgByCustomer(customerId) {
      const { data, error } = await db.from('stripe_customers').select('organization_id').eq('stripe_customer_id', customerId).maybeSingle()
      if (error) fail('find_org_by_customer', error)
      return (data?.organization_id as string | undefined) ?? null
    },
    async getOrganizationName(org) {
      const { data, error } = await db.from('organizations').select('name').eq('id', org).maybeSingle()
      if (error) fail('get_org', error)
      return (data?.name as string | undefined) ?? null
    },
    async getCurrentStripeSubscription(org) {
      const { data, error } = await db
        .from('organization_subscriptions')
        .select('stripe_subscription_id, status, plan_code, cancel_at_period_end, current_period_end, created_at')
        .eq('organization_id', org)
        .eq('source', 'stripe')
        .not('status', 'in', '(canceled,incomplete_expired)')
        .order('created_at', { ascending: false })
        .limit(1)
      if (error) fail('get_subscription', error)
      return ((data ?? [])[0] as CurrentStripeSubscription | undefined) ?? null
    },
    async claimEvent(eventId, type, livemode, createdAt) {
      const { data, error } = await db.rpc('billing_claim_webhook_event', {
        p_event_id: eventId,
        p_type: type,
        p_livemode: livemode,
        p_created: createdAt.toISOString(),
      })
      if (error) fail('claim_event', error)
      return data as ClaimResult
    },
    async finishEvent(eventId, status, err = null, org = null, objectId = null) {
      const { error } = await db.rpc('billing_finish_webhook_event', { p_event_id: eventId, p_status: status, p_error: err, p_org: org, p_object_id: objectId })
      if (error) fail('finish_event', error)
    },
    async applySubscription(payload) {
      const { data, error } = await db.rpc('billing_apply_subscription', { p: payload })
      if (error) fail('apply_subscription', error)
      return data as { applied: boolean; reason?: string; status?: string; plan?: string | null }
    },
    async upsertInvoice(payload) {
      const { data, error } = await db.rpc('billing_upsert_invoice', { p: payload })
      if (error) fail('upsert_invoice', error)
      return data as { applied: boolean; reason?: string }
    },
    async audit(org, actor, action, metadata = {}) {
      const { error } = await db.rpc('billing_write_audit', { p_org: org, p_actor: actor, p_action: action, p_metadata: metadata })
      if (error) log('warn', 'billing_store.audit_failed', { action, code: error.code })
    },

    // ─── Rivenditori ───────────────────────────────────────────────────────
    async listResellerPlans() {
      const { data, error } = await db.from('reseller_plans').select('code, name, setup_fee_cents, monthly_price_cents, stripe_monthly_price_id, stripe_setup_price_id, is_active').order('sort_order')
      if (error) fail('list_reseller_plans', error)
      return (data ?? []) as ResellerPlanRow[]
    },
    async getResellerBilling(resellerId) {
      const { data, error } = await db.from('resellers').select('id, name, plan_code, status, stripe_customer_id, stripe_customer_livemode').eq('id', resellerId).is('deleted_at', null).maybeSingle()
      if (error) fail('get_reseller', error)
      if (!data) return null
      const subs = await db.from('reseller_subscriptions').select('source, status, stripe_subscription_id, current_period_end, created_at').eq('reseller_id', resellerId).order('created_at', { ascending: false })
      if (subs.error) fail('get_reseller_subscriptions', subs.error)
      const rows = (subs.data ?? []) as { source: 'stripe' | 'external'; status: string; stripe_subscription_id: string | null }[]
      const live = rows.find((r) => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(r.status)) ?? null
      return { ...(data as Omit<ResellerBillingRow, 'had_stripe_subscription' | 'current'>), had_stripe_subscription: rows.some((r) => r.source === 'stripe'), current: live }
    },
    async linkResellerCustomer(resellerId, customerId, livemode) {
      const { data, error } = await db.rpc('billing_link_reseller_customer', { p_reseller: resellerId, p_customer: customerId, p_livemode: livemode })
      if (error) fail('link_reseller_customer', error)
      return data as string
    },
    async findResellerByCustomer(customerId) {
      const { data, error } = await db.from('resellers').select('id').eq('stripe_customer_id', customerId).maybeSingle()
      if (error) fail('find_reseller_by_customer', error)
      return (data?.id as string | undefined) ?? null
    },
    async applyResellerSubscription(payload) {
      const { data, error } = await db.rpc('billing_apply_reseller_subscription', { p: payload })
      if (error) fail('apply_reseller_subscription', error)
      return data as { applied: boolean; reason?: string }
    },
    async upsertResellerInvoice(payload) {
      const { data, error } = await db.rpc('billing_upsert_reseller_invoice', { p: payload })
      if (error) fail('upsert_reseller_invoice', error)
      return data as { applied: boolean; reason?: string }
    },
  }
}

/** Controlli di piano/quote via RPC del database (service role). */
export function createBillingGate(db: SupabaseClient): BillingGate {
  return {
    async canUseFeature(org, feature) {
      const { data, error } = await db.rpc('billing_can_use_feature', { p_org: org, p_feature: feature })
      if (error) fail('can_use_feature', error)
      return data as FeatureDecision
    },
    async leadQuota(org) {
      const { data, error } = await db.rpc('billing_lead_quota', { p_org: org })
      if (error) fail('lead_quota', error)
      return data as LeadQuotaDecision
    },
    async countNewLeads(org, user, refs, metadata = {}) {
      if (refs.length === 0) return { enforced: true, counted: 0, already_counted: 0, over_quota_refs: [] }
      const { data, error } = await db.rpc('billing_count_new_leads', { p_org: org, p_user: user, p_refs: refs, p_metadata: metadata })
      if (error) fail('count_new_leads', error)
      const r = data as LeadCountResult
      return { ...r, over_quota_refs: Array.isArray(r.over_quota_refs) ? r.over_quota_refs : [] }
    },
    async recordProviderCall(org, user, provider, idempotencyKey) {
      const { error } = await db.rpc('billing_record_provider_call', { p_org: org, p_user: user, p_provider: provider, p_idempotency_key: idempotencyKey })
      if (!error) return
      // Provider sospeso dal super admin: la ricerca si ferma prima di chiamare (e pagare) il provider.
      const blocked = billingDbError(error)
      if (blocked) throw blocked
      log('warn', 'billing_store.provider_call_not_recorded', { provider, code: error.code })
    },
  }
}
