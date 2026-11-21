import { HttpError } from '../http'
import { log } from '../log'
import type { StripeConfig } from './config'
import { changeDirection, invoicePayload, invoiceSubscriptionId, priceIdForPlan, resellerPriceIds, resellerSubscriptionPayload, subscriptionPayload, type PlanRow } from './mapping'
import { idOf, StripeApiError, type StripeEvent, type StripeGateway, type StripeSubscription } from './stripeClient'
import type { BillingStore } from './store'

export interface BillingDeps {
  store: BillingStore
  stripe: StripeGateway
  config: StripeConfig
  now?: () => Date
}

export interface BillingCtx {
  orgId: string
  userId: string
  email: string | null
}

const ACTIVE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'])

function stripeHttp(err: unknown): never {
  if (err instanceof StripeApiError) {
    log('warn', 'stripe.api_error', { status: err.status, type: err.type, code: err.stripeCode })
    throw new HttpError(err.retryable ? 503 : 502, 'stripe_unavailable', { retryable: err.retryable })
  }
  throw err
}

async function activePlan(store: BillingStore, code: string): Promise<{ plan: PlanRow; plans: PlanRow[] }> {
  const plans = await store.listPlans()
  const plan = plans.find((p) => p.code === code && p.is_active)
  if (!plan) throw new HttpError(404, 'plan_not_found')
  return { plan, plans }
}

async function ensureCustomer(deps: BillingDeps, ctx: BillingCtx): Promise<string> {
  const { store, stripe, config } = deps
  const existing = await store.getCustomer(ctx.orgId)
  if (existing) {
    // Un customer di test non può essere usato in live (e viceversa).
    if (existing.livemode !== (config.mode === 'live')) throw new HttpError(409, 'customer_mode_mismatch')
    return existing.stripe_customer_id
  }
  const name = (await store.getOrganizationName(ctx.orgId)) ?? 'Organizzazione LeadFlow'
  // Idempotency-Key per organizzazione: richieste parallele ottengono lo stesso customer.
  const created = await stripe.createCustomer({ organizationId: ctx.orgId, name, email: ctx.email }, `leadflow-customer-${ctx.orgId}`).catch(stripeHttp)
  if (created.livemode !== (config.mode === 'live')) throw new HttpError(409, 'customer_mode_mismatch')
  return store.linkCustomer(ctx.orgId, created.id, created.livemode)
}

// ════════════════════════════════════════════════════════════════════════════
// Checkout (Stripe Checkout ospitato)
// ════════════════════════════════════════════════════════════════════════════
/** Pagine di ritorno ammesse dopo il Checkout (lista chiusa: nessun redirect arbitrario). */
const CHECKOUT_RETURN: Record<'billing' | 'onboarding', string> = { billing: '/dashboard/billing', onboarding: '/onboarding' }

export async function startCheckout(
  deps: BillingDeps,
  ctx: BillingCtx,
  planCode: string,
  returnTo: 'billing' | 'onboarding' = 'billing',
): Promise<{ url: string; session_id: string }> {
  const { store, stripe, config } = deps
  const { plan } = await activePlan(store, planCode)
  const priceId = priceIdForPlan(plan, config.envPrices)
  if (!priceId) throw new HttpError(409, 'plan_price_not_configured', { plan: plan.code })

  const current = await store.getCurrentStripeSubscription(ctx.orgId)
  if (current && ACTIVE.has(current.status)) {
    // Un'organizzazione ha un solo abbonamento: i cambi passano da change-plan o dal portale.
    throw new HttpError(409, 'subscription_exists', { status: current.status, plan_code: current.plan_code })
  }

  const customerId = await ensureCustomer(deps, ctx)
  const minute = Math.floor((deps.now?.() ?? new Date()).getTime() / 60_000)
  const session = await stripe
    .createCheckoutSession(
      {
        customerId,
        priceId,
        organizationId: ctx.orgId,
        planCode: plan.code,
        successUrl: `${config.appUrl}${CHECKOUT_RETURN[returnTo]}?checkout=success`,
        cancelUrl: `${config.appUrl}${CHECKOUT_RETURN[returnTo]}?checkout=cancelled`,
      },
      // Doppio clic entro lo stesso minuto → stessa sessione.
      `leadflow-checkout-${ctx.orgId}-${plan.code}-${minute}`,
    )
    .catch(stripeHttp)
  if (!session.url || !session.url.startsWith('https://')) throw new HttpError(502, 'stripe_unavailable')
  await store.audit(ctx.orgId, ctx.userId, 'checkout.started', { plan: plan.code, session: session.id, mode: config.mode })
  // L'abbonamento NON viene attivato qui né al ritorno sulla pagina di successo: solo dal webhook.
  return { url: session.url, session_id: session.id }
}

// ════════════════════════════════════════════════════════════════════════════
// Customer Portal
// ════════════════════════════════════════════════════════════════════════════
export async function openPortal(deps: BillingDeps, ctx: BillingCtx): Promise<{ url: string }> {
  const customer = await deps.store.getCustomer(ctx.orgId)
  if (!customer) throw new HttpError(409, 'no_billing_account')
  if (customer.livemode !== (deps.config.mode === 'live')) throw new HttpError(409, 'customer_mode_mismatch')
  const session = await deps.stripe.createPortalSession({ customerId: customer.stripe_customer_id, returnUrl: `${deps.config.appUrl}/dashboard/billing` }).catch(stripeHttp)
  if (!session.url?.startsWith('https://')) throw new HttpError(502, 'stripe_unavailable')
  await deps.store.audit(ctx.orgId, ctx.userId, 'portal.opened', {})
  return { url: session.url }
}

// ════════════════════════════════════════════════════════════════════════════
// Upgrade / downgrade / cancellazione (lo stato salvato arriva da Stripe)
// ════════════════════════════════════════════════════════════════════════════
async function loadOwnSubscription(deps: BillingDeps, ctx: BillingCtx): Promise<StripeSubscription> {
  const current = await deps.store.getCurrentStripeSubscription(ctx.orgId)
  if (!current) throw new HttpError(409, 'no_active_subscription')
  const sub = await deps.stripe.retrieveSubscription(current.stripe_subscription_id).catch(stripeHttp)
  const customer = await deps.store.getCustomer(ctx.orgId)
  if (!customer || idOf(sub.customer) !== customer.stripe_customer_id) throw new HttpError(409, 'subscription_customer_mismatch')
  return sub
}

async function applyFromStripe(deps: BillingDeps, orgId: string, sub: StripeSubscription, syncedAt: Date, eventType: string | null) {
  const plans = await deps.store.listPlans()
  return deps.store.applySubscription(subscriptionPayload(sub, orgId, plans, deps.config.envPrices, syncedAt, eventType))
}

export async function changePlan(deps: BillingDeps, ctx: BillingCtx, planCode: string) {
  const { plan: target, plans } = await activePlan(deps.store, planCode)
  const priceId = priceIdForPlan(target, deps.config.envPrices)
  if (!priceId) throw new HttpError(409, 'plan_price_not_configured', { plan: target.code })
  const startedAt = deps.now?.() ?? new Date()
  const sub = await loadOwnSubscription(deps, ctx)
  if (!['active', 'trialing'].includes(sub.status)) throw new HttpError(409, 'subscription_not_changeable', { status: sub.status })
  const item = sub.items.data[0]
  if (!item) throw new HttpError(409, 'subscription_not_changeable')
  if (item.price.id === priceId) throw new HttpError(409, 'same_plan')

  const currentPlan = plans.find((p) => priceIdForPlan(p, deps.config.envPrices) === item.price.id)
  const direction = currentPlan ? changeDirection(currentPlan, target) : 'upgrade'
  // Upgrade: differenza pro-rata fatturata subito. Downgrade: credito pro-rata sulla prossima fattura.
  const proration = direction === 'upgrade' ? 'always_invoice' : 'create_prorations'
  const updated = await deps.stripe
    .updateSubscriptionPrice({ subscriptionId: sub.id, itemId: item.id, priceId, prorationBehavior: proration }, `leadflow-plan-${sub.id}-${target.code}-${Math.floor(startedAt.getTime() / 60_000)}`)
    .catch(stripeHttp)
  await deps.store.audit(ctx.orgId, ctx.userId, 'plan_change.requested', { from: currentPlan?.code ?? null, to: target.code, direction })
  // Lo stato restituito da Stripe è autorevole: lo applichiamo subito (il webhook lo confermerà).
  const result = await applyFromStripe(deps, ctx.orgId, updated, startedAt, 'api.plan_change')
  return { direction, status: updated.status, plan_code: result.plan ?? null, pending: updated.items.data[0]?.price.id !== priceId }
}

export async function setCancellation(deps: BillingDeps, ctx: BillingCtx, action: 'cancel' | 'resume') {
  const startedAt = deps.now?.() ?? new Date()
  const sub = await loadOwnSubscription(deps, ctx)
  if (['canceled', 'incomplete_expired'].includes(sub.status)) throw new HttpError(409, 'subscription_not_changeable', { status: sub.status })
  const cancel = action === 'cancel'
  if (sub.cancel_at_period_end === cancel) throw new HttpError(409, cancel ? 'already_cancelling' : 'not_cancelling')
  const updated = await deps.stripe.setCancelAtPeriodEnd(sub.id, cancel, `leadflow-cancel-${sub.id}-${action}-${Math.floor(startedAt.getTime() / 60_000)}`).catch(stripeHttp)
  await deps.store.audit(ctx.orgId, ctx.userId, cancel ? 'cancellation.scheduled' : 'cancellation.revoked', {})
  await applyFromStripe(deps, ctx.orgId, updated, startedAt, cancel ? 'api.cancel' : 'api.resume')
  return { status: updated.status, cancel_at_period_end: updated.cancel_at_period_end }
}

// ════════════════════════════════════════════════════════════════════════════
// Abbonamenti White Label (rivenditori)
// ════════════════════════════════════════════════════════════════════════════
export interface ResellerCtx {
  resellerId: string
  userId: string
  email: string | null
}

export async function startResellerCheckout(deps: BillingDeps, ctx: ResellerCtx): Promise<{ url: string; session_id: string; includes_setup_fee: boolean }> {
  const { store, stripe, config } = deps
  const reseller = await store.getResellerBilling(ctx.resellerId)
  if (!reseller) throw new HttpError(404, 'not_found')
  if (reseller.status !== 'active') throw new HttpError(409, 'reseller_suspended')
  if (reseller.current) throw new HttpError(409, 'subscription_exists', { source: reseller.current.source, status: reseller.current.status })
  const plan = (await store.listResellerPlans()).find((p) => p.code === reseller.plan_code && p.is_active)
  if (!plan) throw new HttpError(404, 'plan_not_found')
  const prices = resellerPriceIds(plan, config.envResellerPrices)
  if (!prices.monthly) throw new HttpError(409, 'plan_price_not_configured', { plan: plan.code })
  // La quota di attivazione si paga una sola volta (primo abbonamento Stripe del rivenditore).
  const includeSetup = plan.setup_fee_cents > 0 && !reseller.had_stripe_subscription
  if (includeSetup && !prices.setup) throw new HttpError(409, 'setup_price_not_configured', { plan: plan.code })

  let customerId = reseller.stripe_customer_id
  if (customerId && reseller.stripe_customer_livemode !== (config.mode === 'live')) throw new HttpError(409, 'customer_mode_mismatch')
  if (!customerId) {
    const created = await stripe.createResellerCustomer({ resellerId: reseller.id, name: reseller.name, email: ctx.email }, `leadflow-reseller-customer-${reseller.id}`).catch(stripeHttp)
    if (created.livemode !== (config.mode === 'live')) throw new HttpError(409, 'customer_mode_mismatch')
    customerId = await store.linkResellerCustomer(reseller.id, created.id, created.livemode)
  }
  const minute = Math.floor((deps.now?.() ?? new Date()).getTime() / 60_000)
  const lineItems = [{ price: prices.monthly, quantity: 1 }, ...(includeSetup && prices.setup ? [{ price: prices.setup, quantity: 1 }] : [])]
  const session = await stripe
    .createResellerCheckoutSession(
      {
        customerId,
        resellerId: reseller.id,
        planCode: plan.code,
        lineItems,
        successUrl: `${config.appUrl}/reseller?checkout=success`,
        cancelUrl: `${config.appUrl}/reseller?checkout=cancelled`,
      },
      `leadflow-reseller-checkout-${reseller.id}-${plan.code}-${minute}`,
    )
    .catch(stripeHttp)
  if (!session.url?.startsWith('https://')) throw new HttpError(502, 'stripe_unavailable')
  return { url: session.url, session_id: session.id, includes_setup_fee: includeSetup }
}

export async function openResellerPortal(deps: BillingDeps, ctx: ResellerCtx): Promise<{ url: string }> {
  const reseller = await deps.store.getResellerBilling(ctx.resellerId)
  if (!reseller?.stripe_customer_id) throw new HttpError(409, 'no_billing_account')
  if (reseller.stripe_customer_livemode !== (deps.config.mode === 'live')) throw new HttpError(409, 'customer_mode_mismatch')
  const session = await deps.stripe.createPortalSession({ customerId: reseller.stripe_customer_id, returnUrl: `${deps.config.appUrl}/reseller` }).catch(stripeHttp)
  if (!session.url?.startsWith('https://')) throw new HttpError(502, 'stripe_unavailable')
  return { url: session.url }
}

// ════════════════════════════════════════════════════════════════════════════
// Webhook
// ════════════════════════════════════════════════════════════════════════════
export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const

export type WebhookOutcome =
  | { http: 200; status: 'processed' | 'duplicate' | 'ignored'; reason?: string }
  | { http: 409; status: 'in_progress' }
  | { http: 500; status: 'failed'; reason: string }

class SkipEvent extends Error {
  constructor(public reason: string) {
    super(reason)
  }
}

/**
 * Sincronizza un abbonamento leggendo lo stato CORRENTE da Stripe: l'ordine di arrivo degli
 * eventi non conta (un evento vecchio porta comunque allo stato attuale; un risultato letto
 * prima di quello già salvato viene scartato dal database tramite stripe_synced_at).
 */
async function syncSubscription(deps: BillingDeps, subscriptionId: string, eventType: string): Promise<string | null> {
  const syncedAt = deps.now?.() ?? new Date()
  const sub = await deps.stripe.retrieveSubscription(subscriptionId)
  const customerId = idOf(sub.customer)
  const org = customerId ? await deps.store.findOrgByCustomer(customerId) : null
  if (!org) {
    // Abbonamento White Label: il customer appartiene a un rivenditore.
    const reseller = customerId ? await deps.store.findResellerByCustomer(customerId) : null
    if (!reseller) throw new SkipEvent('unknown_customer')
    if (sub.metadata?.reseller_id && sub.metadata.reseller_id !== reseller) throw new SkipEvent('reseller_mismatch')
    const plans = await deps.store.listResellerPlans()
    const r = await deps.store.applyResellerSubscription(resellerSubscriptionPayload(sub, reseller, plans, deps.config.envResellerPrices, syncedAt, eventType))
    if (!r.applied) log('info', 'stripe_webhook.stale_state_skipped', { subscription: sub.id })
    return null
  }
  const metaOrg = sub.metadata?.organization_id
  if (metaOrg && metaOrg !== org) {
    log('warn', 'stripe_webhook.org_mismatch', { subscription: sub.id })
    throw new SkipEvent('organization_mismatch')
  }
  const r = await applyFromStripe(deps, org, sub, syncedAt, eventType)
  if (!r.applied) log('info', 'stripe_webhook.stale_state_skipped', { subscription: sub.id })
  return org
}

async function handleEvent(deps: BillingDeps, event: StripeEvent): Promise<{ org: string | null; objectId: string | null }> {
  const obj = event.data?.object ?? {}
  const objectId = typeof obj.id === 'string' ? obj.id : null
  switch (event.type) {
    case 'checkout.session.completed': {
      if (!objectId) throw new SkipEvent('missing_object')
      // Sessione riletta da Stripe: non ci si fida del payload né del redirect di successo.
      const session = await deps.stripe.retrieveCheckoutSession(objectId)
      if (session.mode !== 'subscription') throw new SkipEvent('not_a_subscription_checkout')
      const subId = idOf(session.subscription)
      const customerId = idOf(session.customer)
      if (!subId || !customerId) throw new SkipEvent('session_without_subscription')
      const org = await deps.store.findOrgByCustomer(customerId)
      if (!org) {
        const reseller = await deps.store.findResellerByCustomer(customerId)
        if (!reseller) throw new SkipEvent('unknown_customer')
        if (session.client_reference_id && session.client_reference_id !== reseller) throw new SkipEvent('reseller_mismatch')
        await syncSubscription(deps, subId, event.type)
        return { org: null, objectId }
      }
      if (session.client_reference_id && session.client_reference_id !== org) throw new SkipEvent('organization_mismatch')
      await syncSubscription(deps, subId, event.type)
      await deps.store.audit(org, null, 'checkout.completed', { session: session.id, payment_status: session.payment_status })
      return { org, objectId }
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (!objectId) throw new SkipEvent('missing_object')
      return { org: await syncSubscription(deps, objectId, event.type), objectId }
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      if (!objectId) throw new SkipEvent('missing_object')
      const syncedAt = deps.now?.() ?? new Date()
      const invoice = await deps.stripe.retrieveInvoice(objectId)
      const customerId = idOf(invoice.customer)
      const org = customerId ? await deps.store.findOrgByCustomer(customerId) : null
      if (!org) {
        const reseller = customerId ? await deps.store.findResellerByCustomer(customerId) : null
        if (!reseller) throw new SkipEvent('unknown_customer')
        const { organization_id: _o, ...rest } = invoicePayload(invoice, reseller, syncedAt, event.type, event.id)
        await deps.store.upsertResellerInvoice({ ...rest, reseller_id: reseller })
        const rsub = invoiceSubscriptionId(invoice)
        if (rsub) await syncSubscription(deps, rsub, event.type)
        return { org: null, objectId }
      }
      await deps.store.upsertInvoice(invoicePayload(invoice, org, syncedAt, event.type, event.id))
      // Rinnovo o pagamento fallito: anche lo stato dell'abbonamento cambia (periodo, past_due).
      const subId = invoiceSubscriptionId(invoice)
      if (subId) await syncSubscription(deps, subId, event.type)
      return { org, objectId }
    }
    default:
      throw new SkipEvent('event_not_handled')
  }
}

/** Elabora un evento GIÀ verificato (firma). Idempotente per event.id. */
export async function processWebhookEvent(deps: BillingDeps, event: StripeEvent): Promise<WebhookOutcome> {
  const { store, config } = deps
  const created = new Date((event.created || 0) * 1000)
  const claim = await store.claimEvent(event.id, event.type, event.livemode, created)
  if (claim === 'duplicate') return { http: 200, status: 'duplicate' }
  if (claim === 'in_progress') return { http: 409, status: 'in_progress' }

  if (event.livemode !== (config.mode === 'live')) {
    await store.finishEvent(event.id, 'ignored', 'livemode_mismatch')
    log('warn', 'stripe_webhook.livemode_mismatch', { event_id: event.id, type: event.type })
    return { http: 200, status: 'ignored', reason: 'livemode_mismatch' }
  }

  try {
    const { org, objectId } = await handleEvent(deps, event)
    await store.finishEvent(event.id, 'processed', null, org, objectId)
    log('info', 'stripe_webhook.processed', { event_id: event.id, type: event.type })
    return { http: 200, status: 'processed' }
  } catch (err) {
    if (err instanceof SkipEvent) {
      await store.finishEvent(event.id, 'ignored', err.reason)
      log(err.reason === 'event_not_handled' ? 'info' : 'warn', 'stripe_webhook.ignored', { event_id: event.id, type: event.type, reason: err.reason })
      return { http: 200, status: 'ignored', reason: err.reason }
    }
    if (err instanceof StripeApiError && !err.retryable && err.stripeCode === 'resource_missing') {
      await store.finishEvent(event.id, 'ignored', 'stripe_resource_missing')
      return { http: 200, status: 'ignored', reason: 'stripe_resource_missing' }
    }
    const reason = err instanceof StripeApiError ? `stripe_${err.type}` : err instanceof HttpError ? err.code : 'internal_error'
    await store.finishEvent(event.id, 'failed', reason).catch(() => undefined)
    log('error', 'stripe_webhook.failed', { event_id: event.id, type: event.type, reason })
    // 500 → Stripe ritenta con backoff; il retry è sicuro perché ogni scrittura è idempotente.
    return { http: 500, status: 'failed', reason }
  }
}
