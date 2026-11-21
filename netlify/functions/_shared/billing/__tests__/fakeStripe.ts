import { StripeApiError, type StripeCheckoutSession, type StripeGateway, type StripeInvoice, type StripeSubscription } from '../stripeClient'

/**
 * Gateway Stripe finto SOLO per i test: stato in memoria che imita le risposte dell'API
 * (versione basil: periodo sugli item, invoice.parent). Nessuna transazione reale.
 */
export const PRICES = { starter: 'price_TESTstarter01', business: 'price_TESTbusiness1', enterprise: 'price_TESTenterpr01' } as const
export const RESELLER_PRICES = { agency: { monthly: 'price_TESTagencyM1', setup: 'price_TESTagencyS1' }, premium: { monthly: 'price_TESTpremiumM', setup: 'price_TESTpremiumS' } } as const
const UNIT: Record<string, number> = { [PRICES.starter]: 14900, [PRICES.business]: 34900, [PRICES.enterprise]: 79900, price_TESTagencyM1: 39900, price_TESTpremiumM: 79900 }

export function makeSubscription(p: { id: string; customer: string; price: string; status?: StripeSubscription['status']; start?: number; end?: number; org?: string; livemode?: boolean }): StripeSubscription {
  const start = p.start ?? 1_763_600_000
  const end = p.end ?? start + 30 * 86400
  return {
    id: p.id,
    object: 'subscription',
    customer: p.customer,
    status: p.status ?? 'active',
    items: { data: [{ id: `si_${p.id.slice(4)}`, price: { id: p.price, unit_amount: UNIT[p.price] ?? 0, currency: 'eur', recurring: { interval: 'month', interval_count: 1 } }, current_period_start: start, current_period_end: end }] },
    metadata: p.org ? { organization_id: p.org } : {},
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    start_date: start,
    trial_end: null,
    livemode: p.livemode ?? false,
  }
}

export function makeInvoice(p: { id: string; customer: string; subscription: string; status: StripeInvoice['status']; total: number; net: number; paid: number; attempt?: number }): StripeInvoice {
  return {
    id: p.id,
    object: 'invoice',
    customer: p.customer,
    status: p.status,
    number: 'TEST-0001',
    billing_reason: 'subscription_cycle',
    currency: 'eur',
    subtotal: p.net,
    total: p.total,
    total_excluding_tax: p.net,
    amount_due: p.total,
    amount_paid: p.paid,
    amount_remaining: p.total - p.paid,
    attempt_count: p.attempt ?? 1,
    period_start: 1_763_600_000,
    period_end: 1_766_192_000,
    hosted_invoice_url: 'https://invoice.stripe.com/i/test',
    invoice_pdf: 'https://pay.stripe.com/invoice/test/pdf',
    next_payment_attempt: null,
    livemode: false,
    created: 1_763_600_000,
    status_transitions: { paid_at: p.status === 'paid' ? 1_763_600_100 : null },
    parent: { subscription_details: { subscription: p.subscription } },
  }
}

export function createFakeStripe() {
  const subscriptions = new Map<string, StripeSubscription>()
  const invoices = new Map<string, StripeInvoice>()
  const sessions = new Map<string, StripeCheckoutSession>()
  const calls: { op: string; args: unknown; key?: string }[] = []
  let customerSeq = 0
  const customersByKey = new Map<string, string>()
  let failNext: StripeApiError | null = null

  const maybeFail = () => {
    if (failNext) {
      const e = failNext
      failNext = null
      throw e
    }
  }

  const gateway: StripeGateway = {
    async createCustomer(p, key) {
      calls.push({ op: 'createCustomer', args: p, key })
      maybeFail()
      // Stripe restituisce lo stesso oggetto per la stessa Idempotency-Key.
      if (!customersByKey.has(key)) customersByKey.set(key, `cus_TESTfake${String(++customerSeq).padStart(4, '0')}`)
      return { id: customersByKey.get(key)!, livemode: false }
    },
    async createCheckoutSession(p, key) {
      calls.push({ op: 'createCheckoutSession', args: p, key })
      maybeFail()
      const id = `cs_test_${sessions.size + 1}`
      const s: StripeCheckoutSession = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, mode: 'subscription', status: 'open', payment_status: 'unpaid', customer: p.customerId, subscription: null, client_reference_id: p.organizationId, metadata: { organization_id: p.organizationId }, livemode: false }
      sessions.set(id, s)
      return s
    },
    async createResellerCheckoutSession(p, key) {
      calls.push({ op: 'createResellerCheckoutSession', args: p, key })
      maybeFail()
      const id = `cs_test_r${sessions.size + 1}`
      const s: StripeCheckoutSession = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, mode: 'subscription', status: 'open', payment_status: 'unpaid', customer: p.customerId, subscription: null, client_reference_id: p.resellerId, metadata: { reseller_id: p.resellerId }, livemode: false }
      sessions.set(id, s)
      return s
    },
    async createResellerCustomer(p, key) {
      calls.push({ op: 'createResellerCustomer', args: p, key })
      maybeFail()
      if (!customersByKey.has(key)) customersByKey.set(key, `cus_TESTres${String(++customerSeq).padStart(4, '0')}`)
      return { id: customersByKey.get(key)!, livemode: false }
    },
    async createPortalSession(p) {
      calls.push({ op: 'createPortalSession', args: p })
      maybeFail()
      return { url: 'https://billing.stripe.com/p/session/test_123' }
    },
    async retrieveSubscription(id) {
      calls.push({ op: 'retrieveSubscription', args: id })
      maybeFail()
      const s = subscriptions.get(id)
      if (!s) throw new StripeApiError(404, 'invalid_request_error', 'resource_missing', false)
      return structuredClone(s)
    },
    async updateSubscriptionPrice(p, key) {
      calls.push({ op: 'updateSubscriptionPrice', args: p, key })
      maybeFail()
      const s = subscriptions.get(p.subscriptionId)!
      s.items.data[0]!.price = { ...s.items.data[0]!.price, id: p.priceId, unit_amount: UNIT[p.priceId] ?? 0 }
      return structuredClone(s)
    },
    async setCancelAtPeriodEnd(id, cancel, key) {
      calls.push({ op: 'setCancelAtPeriodEnd', args: { id, cancel }, key })
      maybeFail()
      const s = subscriptions.get(id)!
      s.cancel_at_period_end = cancel
      s.cancel_at = cancel ? s.items.data[0]!.current_period_end ?? null : null
      return structuredClone(s)
    },
    async retrieveInvoice(id) {
      calls.push({ op: 'retrieveInvoice', args: id })
      maybeFail()
      const i = invoices.get(id)
      if (!i) throw new StripeApiError(404, 'invalid_request_error', 'resource_missing', false)
      return structuredClone(i)
    },
    async retrieveCheckoutSession(id) {
      calls.push({ op: 'retrieveCheckoutSession', args: id })
      maybeFail()
      const s = sessions.get(id)
      if (!s) throw new StripeApiError(404, 'invalid_request_error', 'resource_missing', false)
      return structuredClone(s)
    },
  }
  return {
    gateway,
    subscriptions,
    invoices,
    sessions,
    calls,
    failNextWith: (e: StripeApiError) => {
      failNext = e
    },
  }
}
