/** Risposta di GET /api/billing/status (dati reali dal database, sincronizzati da Stripe). */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid' | 'paused'

export interface BillingPlan {
  code: string
  name: string
  description: string | null
  price_cents: number
  currency: string
  monthly_leads: number
  monthly_ai_credits: number
  max_users: number
  features: string[]
  is_active: boolean
  sort_order: number
  purchasable: boolean
}

export interface BillingInvoice {
  stripe_invoice_id: string
  number: string | null
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void'
  currency: string
  total_cents: number
  total_excluding_tax_cents: number | null
  amount_paid_cents: number
  amount_remaining_cents: number
  period_start: string | null
  period_end: string | null
  paid_at: string | null
  hosted_invoice_url: string | null
  invoice_pdf: string | null
  stripe_created_at: string | null
  livemode: boolean
}

export interface BillingStatus {
  entitlements: {
    enforced: boolean
    has_access: boolean
    plan_code: string | null
    status: SubscriptionStatus | null
    source: 'stripe' | 'manual' | null
    features: string[]
    max_users: number
  }
  subscription: null | {
    source: 'stripe' | 'manual'
    status: SubscriptionStatus
    plan_code: string | null
    unit_amount_cents: number | null
    currency: string | null
    billing_interval: string | null
    current_period_start: string | null
    current_period_end: string | null
    cancel_at_period_end: boolean
    cancel_at: string | null
    canceled_at: string | null
    livemode: boolean
  }
  usage: {
    period_start: string | null
    period_end: string | null
    ai_credits: { limit: number; used: number; reserved: number; available: number }
    leads: { limit: number; used: number; remaining: number }
    users: { limit: number; used: number }
  }
  has_customer: boolean
  is_admin: boolean
  plans: BillingPlan[]
  credit_costs: { operation: string; credits: number; feature: string; description: string }[]
  invoices: BillingInvoice[]
  stripe: { configured: boolean; mode: 'test' | 'live' | null; webhook_configured: boolean; missing: string[]; blocked: string[] }
}

export interface RevenueMetrics {
  livemode: boolean
  window_days: number
  currency: string
  mrr_cents: number
  mrr_at_risk_cents: number
  active_subscriptions: number
  trialing_subscriptions: number
  past_due_subscriptions: number
  new_subscriptions: number
  cancellations: number
  scheduled_cancellations: number
  active_at_window_start: number
  failed_payments: number
  open_invoices: number
  gross_collected_cents: number
  net_collected_cents: number
  ai_cost_usd: number
  provider_cost_usd: number
  jobs_without_cost: number
  by_plan: { plan_code: string | null; count: number; mrr_cents: number }[]
  organizations: {
    id: string
    name: string
    plan_code: string | null
    credits: number
    tokens: number
    ai_cost_usd: number
    provider_cost_usd: number
    jobs_without_cost: number
    net_collected_cents: number
  }[]
}
