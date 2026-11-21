import type { StripeConfig } from './config'

/**
 * Client Stripe minimo sull'API REST ufficiale (https://api.stripe.com/v1), con versione
 * API fissata, Idempotency-Key sulle scritture e timeout. Nessun dato di carta transita
 * dal server: il pagamento avviene su Stripe Checkout ospitato.
 *
 * L'interfaccia StripeGateway isola il resto del codice dal trasporto: si può sostituire
 * con l'SDK ufficiale `stripe` senza toccare servizi, webhook o test.
 */

// ─── Tipi (sottoinsieme dei campi usati) ────────────────────────────────────
export interface StripePrice {
  id: string
  unit_amount: number | null
  currency: string
  recurring: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number } | null
}
export interface StripeSubscriptionItem {
  id: string
  price: StripePrice
  quantity?: number
  current_period_start?: number
  current_period_end?: number
}
export interface StripeSubscription {
  id: string
  object: 'subscription'
  customer: string | { id: string }
  status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused'
  items: { data: StripeSubscriptionItem[] }
  metadata: Record<string, string>
  cancel_at_period_end: boolean
  cancel_at: number | null
  canceled_at: number | null
  ended_at: number | null
  start_date: number | null
  trial_end: number | null
  livemode: boolean
  /** Presenti nelle versioni API precedenti a basil (nelle successive sono sugli item). */
  current_period_start?: number
  current_period_end?: number
}
export interface StripeInvoice {
  id: string
  object: 'invoice'
  customer: string | { id: string } | null
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | null
  number: string | null
  billing_reason: string | null
  currency: string
  subtotal: number
  total: number
  total_excluding_tax: number | null
  amount_due: number
  amount_paid: number
  amount_remaining: number
  attempt_count: number
  period_start: number | null
  period_end: number | null
  hosted_invoice_url: string | null
  invoice_pdf: string | null
  next_payment_attempt: number | null
  livemode: boolean
  created: number
  status_transitions?: { paid_at: number | null }
  /** Versioni API < basil. */
  subscription?: string | { id: string } | null
  /** Versioni API ≥ basil. */
  parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null
}
export interface StripeCheckoutSession {
  id: string
  object: 'checkout.session'
  url: string | null
  mode: string
  status: string | null
  payment_status: string
  customer: string | { id: string } | null
  subscription: string | { id: string } | null
  client_reference_id: string | null
  metadata: Record<string, string> | null
  livemode: boolean
}
export interface StripeEvent {
  id: string
  object: 'event'
  type: string
  created: number
  livemode: boolean
  data: { object: { id?: string; object?: string; [k: string]: unknown } }
}

export interface StripeGateway {
  createCustomer(p: { organizationId: string; name: string; email: string | null }, idempotencyKey: string): Promise<{ id: string; livemode: boolean }>
  createCheckoutSession(p: {
    customerId: string
    priceId: string
    organizationId: string
    planCode: string
    successUrl: string
    cancelUrl: string
  }, idempotencyKey: string): Promise<StripeCheckoutSession>
  /** Abbonamento White Label: canone ricorrente + eventuale quota di attivazione una tantum. */
  createResellerCheckoutSession(p: {
    customerId: string
    resellerId: string
    planCode: string
    lineItems: { price: string; quantity: number }[]
    successUrl: string
    cancelUrl: string
  }, idempotencyKey: string): Promise<StripeCheckoutSession>
  createResellerCustomer(p: { resellerId: string; name: string; email: string | null }, idempotencyKey: string): Promise<{ id: string; livemode: boolean }>
  createPortalSession(p: { customerId: string; returnUrl: string }): Promise<{ url: string }>
  retrieveSubscription(id: string): Promise<StripeSubscription>
  updateSubscriptionPrice(p: { subscriptionId: string; itemId: string; priceId: string; prorationBehavior: 'create_prorations' | 'always_invoice' | 'none' }, idempotencyKey: string): Promise<StripeSubscription>
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean, idempotencyKey: string): Promise<StripeSubscription>
  retrieveInvoice(id: string): Promise<StripeInvoice>
  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>
}

export class StripeApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    public stripeCode: string | null,
    /** true se ha senso ritentare (rete, 429, 5xx). */
    public retryable: boolean,
  ) {
    super(`stripe_${type}`)
  }
}

// ─── Codifica application/x-www-form-urlencoded con chiavi annidate ─────────
type FormValue = string | number | boolean | null | undefined | FormValue[] | { [k: string]: FormValue }

export function encodeForm(params: Record<string, FormValue>): string {
  const out: string[] = []
  const walk = (prefix: string, value: FormValue) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v))
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}[${k}]` : k, v)
    } else {
      out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`)
    }
  }
  walk('', params as FormValue)
  return out.join('&')
}

const API = 'https://api.stripe.com/v1'
const idOf = (v: string | { id: string } | null | undefined): string | null => (v == null ? null : typeof v === 'string' ? v : v.id)
export { idOf }

export function createStripeGateway(cfg: Pick<StripeConfig, 'secretKey' | 'apiVersion' | 'automaticTax'>, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): StripeGateway {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 15_000

  async function call<T>(method: 'GET' | 'POST', path: string, params?: Record<string, FormValue>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${cfg.secretKey}`,
      'stripe-version': cfg.apiVersion,
      'user-agent': 'LeadFlowAI/1.0 (+server)',
    }
    let url = `${API}${path}`
    let body: string | undefined
    if (method === 'GET' && params) url += `?${encodeForm(params)}`
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = encodeForm(params ?? {})
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
    }
    let res: Response
    try {
      res = await doFetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw new StripeApiError(0, 'network_error', null, true)
    }
    const data = (await res.json().catch(() => null)) as ({ error?: { type?: string; code?: string } } & Record<string, unknown>) | null
    if (!res.ok || !data) {
      const type = data?.error?.type ?? 'api_error'
      throw new StripeApiError(res.status, type, data?.error?.code ?? null, res.status === 429 || res.status >= 500 || res.status === 409)
    }
    return data as T
  }

  return {
    createCustomer: (p, key) =>
      call('POST', '/customers', {
        name: p.name.slice(0, 250),
        email: p.email ?? undefined,
        metadata: { organization_id: p.organizationId },
      }, key),
    createCheckoutSession: (p, key) =>
      call('POST', '/checkout/sessions', {
        mode: 'subscription',
        customer: p.customerId,
        client_reference_id: p.organizationId,
        line_items: [{ price: p.priceId, quantity: 1 }],
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        // Dati fiscali del cliente B2B raccolti da Stripe (indirizzo e partita IVA).
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        customer_update: { name: 'auto', address: 'auto' },
        ...(cfg.automaticTax ? { automatic_tax: { enabled: true } } : {}),
        allow_promotion_codes: false,
        metadata: { organization_id: p.organizationId, plan_code: p.planCode },
        subscription_data: { metadata: { organization_id: p.organizationId, plan_code: p.planCode } },
      }, key),
    createResellerCheckoutSession: (p, key) =>
      call('POST', '/checkout/sessions', {
        mode: 'subscription',
        customer: p.customerId,
        client_reference_id: p.resellerId,
        // In modalità subscription Stripe accetta Price una tantum: vanno nella prima fattura.
        line_items: p.lineItems,
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        customer_update: { name: 'auto', address: 'auto' },
        ...(cfg.automaticTax ? { automatic_tax: { enabled: true } } : {}),
        allow_promotion_codes: false,
        metadata: { reseller_id: p.resellerId, reseller_plan_code: p.planCode },
        subscription_data: { metadata: { reseller_id: p.resellerId, reseller_plan_code: p.planCode } },
      }, key),
    createResellerCustomer: (p, key) =>
      call('POST', '/customers', { name: p.name.slice(0, 250), email: p.email ?? undefined, metadata: { reseller_id: p.resellerId } }, key),
    createPortalSession: (p) => call('POST', '/billing_portal/sessions', { customer: p.customerId, return_url: p.returnUrl }),
    retrieveSubscription: (id) => call('GET', `/subscriptions/${encodeURIComponent(id)}`),
    updateSubscriptionPrice: (p, key) =>
      call('POST', `/subscriptions/${encodeURIComponent(p.subscriptionId)}`, {
        items: [{ id: p.itemId, price: p.priceId }],
        proration_behavior: p.prorationBehavior,
        // Se il pagamento dell'upgrade non va a buon fine il cambio non viene applicato.
        payment_behavior: 'pending_if_incomplete',
      }, key),
    setCancelAtPeriodEnd: (id, cancel, key) => call('POST', `/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: cancel }, key),
    retrieveInvoice: (id) => call('GET', `/invoices/${encodeURIComponent(id)}`),
    retrieveCheckoutSession: (id) => call('GET', `/checkout/sessions/${encodeURIComponent(id)}`),
  }
}
