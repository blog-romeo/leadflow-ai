import { PLAN_CODES, RESELLER_PLAN_CODES, type PlanCode, type ResellerPlanCode, type StripeConfig } from './config'
import type { ResellerPlanRow } from './store'
import { idOf, type StripeInvoice, type StripeSubscription } from './stripeClient'

/** Piano configurato: dati da billing_plans + eventuale Price ID da variabile d'ambiente. */
export interface PlanRow {
  code: string
  name: string
  price_cents: number
  currency: string
  stripe_price_id: string | null
  monthly_leads: number
  monthly_ai_credits: number
  max_users: number
  features: string[]
  is_active: boolean
  sort_order: number
}

/** Price ID effettivo di un piano: prima billing_plans.stripe_price_id, poi STRIPE_PRICE_<CODE>. */
export function priceIdForPlan(plan: Pick<PlanRow, 'code' | 'stripe_price_id'>, envPrices: Partial<Record<PlanCode, string>>): string | null {
  if (plan.stripe_price_id) return plan.stripe_price_id
  return (PLAN_CODES as readonly string[]).includes(plan.code) ? (envPrices[plan.code as PlanCode] ?? null) : null
}

/** Piano corrispondente a un Price Stripe (null se il prezzo non è riconosciuto). */
export function planForPriceId(priceId: string | null | undefined, plans: PlanRow[], envPrices: Partial<Record<PlanCode, string>>): string | null {
  if (!priceId) return null
  const byDb = plans.find((p) => p.stripe_price_id === priceId)
  if (byDb) return byDb.code
  const byEnv = PLAN_CODES.find((c) => envPrices[c] === priceId)
  return byEnv && plans.some((p) => p.code === byEnv) ? byEnv : null
}

const iso = (s: number | null | undefined): string | null => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString() : null)

export function subscriptionPeriod(sub: StripeSubscription): { start: string | null; end: string | null } {
  // Versioni API ≥ 2025-03-31.basil: il periodo è sugli item; prima era sull'abbonamento.
  const item = sub.items?.data?.[0]
  return {
    start: iso(item?.current_period_start ?? sub.current_period_start),
    end: iso(item?.current_period_end ?? sub.current_period_end),
  }
}

/** Payload per billing_apply_subscription a partire dallo stato appena letto da Stripe. */
export function subscriptionPayload(
  sub: StripeSubscription,
  organizationId: string,
  plans: PlanRow[],
  envPrices: Partial<Record<PlanCode, string>>,
  syncedAt: Date,
  eventType: string | null,
): Record<string, unknown> {
  const item = sub.items?.data?.[0]
  const price = item?.price
  const period = subscriptionPeriod(sub)
  return {
    organization_id: organizationId,
    stripe_subscription_id: sub.id,
    stripe_customer_id: idOf(sub.customer),
    stripe_price_id: price?.id ?? null,
    plan_code: planForPriceId(price?.id, plans, envPrices),
    status: sub.status,
    unit_amount_cents: price?.unit_amount ?? null,
    currency: price?.currency ?? null,
    billing_interval: price?.recurring?.interval ?? null,
    interval_count: price?.recurring?.interval_count ?? null,
    current_period_start: period.start,
    current_period_end: period.end,
    cancel_at_period_end: sub.cancel_at_period_end,
    cancel_at: iso(sub.cancel_at),
    canceled_at: iso(sub.canceled_at),
    ended_at: iso(sub.ended_at),
    started_at: iso(sub.start_date),
    trial_end: iso(sub.trial_end),
    livemode: sub.livemode,
    stripe_synced_at: syncedAt.toISOString(),
    event_type: eventType,
  }
}

export function invoiceSubscriptionId(inv: StripeInvoice): string | null {
  return idOf(inv.parent?.subscription_details?.subscription ?? null) ?? idOf(inv.subscription ?? null)
}

const httpsOrNull = (u: string | null | undefined) => (u && u.startsWith('https://') ? u : null)

export function invoicePayload(inv: StripeInvoice, organizationId: string, syncedAt: Date, eventType: string | null, eventId: string | null): Record<string, unknown> {
  return {
    stripe_invoice_id: inv.id,
    organization_id: organizationId,
    stripe_customer_id: idOf(inv.customer),
    stripe_subscription_id: invoiceSubscriptionId(inv),
    number: inv.number,
    status: inv.status ?? 'draft',
    billing_reason: inv.billing_reason,
    currency: inv.currency,
    subtotal_cents: inv.subtotal,
    total_cents: inv.total,
    total_excluding_tax_cents: inv.total_excluding_tax,
    amount_due_cents: inv.amount_due,
    amount_paid_cents: inv.amount_paid,
    amount_remaining_cents: inv.amount_remaining,
    attempt_count: inv.attempt_count,
    period_start: iso(inv.period_start),
    period_end: iso(inv.period_end),
    hosted_invoice_url: httpsOrNull(inv.hosted_invoice_url),
    invoice_pdf: httpsOrNull(inv.invoice_pdf),
    paid_at: inv.status === 'paid' ? iso(inv.status_transitions?.paid_at ?? null) ?? syncedAt.toISOString() : null,
    next_payment_attempt: iso(inv.next_payment_attempt),
    livemode: inv.livemode,
    stripe_created_at: iso(inv.created),
    stripe_synced_at: syncedAt.toISOString(),
    event_type: eventType,
    event_id: eventId,
  }
}

/** Upgrade se il nuovo piano costa di più (addebito immediato pro-rata), altrimenti downgrade. */
export function changeDirection(current: Pick<PlanRow, 'price_cents'>, target: Pick<PlanRow, 'price_cents'>): 'upgrade' | 'downgrade' | 'same' {
  if (target.price_cents > current.price_cents) return 'upgrade'
  if (target.price_cents < current.price_cents) return 'downgrade'
  return 'same'
}

// ─── Piani White Label ───────────────────────────────────────────────────────
export function resellerPriceIds(plan: Pick<ResellerPlanRow, 'code' | 'stripe_monthly_price_id' | 'stripe_setup_price_id'>, env: StripeConfig['envResellerPrices']) {
  const fromEnv = (RESELLER_PLAN_CODES as readonly string[]).includes(plan.code) ? env[plan.code as ResellerPlanCode] : undefined
  return { monthly: plan.stripe_monthly_price_id ?? fromEnv?.monthly ?? null, setup: plan.stripe_setup_price_id ?? fromEnv?.setup ?? null }
}

export function resellerPlanForPrice(priceId: string | null | undefined, plans: ResellerPlanRow[], env: StripeConfig['envResellerPrices']): string | null {
  if (!priceId) return null
  return plans.find((p) => resellerPriceIds(p, env).monthly === priceId)?.code ?? null
}

/** Payload per billing_apply_reseller_subscription (stato appena letto da Stripe). */
export function resellerSubscriptionPayload(
  sub: StripeSubscription,
  resellerId: string,
  plans: ResellerPlanRow[],
  env: StripeConfig['envResellerPrices'],
  syncedAt: Date,
  eventType: string | null,
): Record<string, unknown> {
  // Il canone ricorrente è l'unico item dell'abbonamento: la quota di attivazione è una riga di fattura.
  const item = sub.items?.data?.find((i) => i.price?.recurring) ?? sub.items?.data?.[0]
  const price = item?.price
  const period = subscriptionPeriod(sub)
  return {
    reseller_id: resellerId,
    stripe_subscription_id: sub.id,
    stripe_customer_id: idOf(sub.customer),
    stripe_price_id: price?.id ?? null,
    plan_code: resellerPlanForPrice(price?.id, plans, env),
    status: sub.status,
    unit_amount_cents: price?.unit_amount ?? null,
    currency: price?.currency ?? null,
    billing_interval: price?.recurring?.interval ?? null,
    interval_count: price?.recurring?.interval_count ?? null,
    current_period_start: period.start,
    current_period_end: period.end,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: iso(sub.canceled_at),
    ended_at: iso(sub.ended_at),
    started_at: iso(sub.start_date),
    livemode: sub.livemode,
    stripe_synced_at: syncedAt.toISOString(),
    event_type: eventType,
  }
}
