import { readStripeConfig, LIVE_APPROVAL_VALUE, type StripeConfig } from '../config'
import { signPayload, verifyStripeSignature, SignatureError } from '../signature'
import { createStripeGateway, encodeForm, StripeApiError, type StripeEvent } from '../stripeClient'
import { invoicePayload, invoiceSubscriptionId, planForPriceId, priceIdForPlan, subscriptionPayload, subscriptionPeriod } from '../mapping'
import { changePlan, openPortal, openResellerPortal, processWebhookEvent, setCancellation, startCheckout, startResellerCheckout, type BillingDeps } from '../service'
import { billingDbError, requireFeature } from '../access'
import { HttpError } from '../../http'
import { createMemoryBillingStore, TEST_PLANS } from './memoryBillingStore'
import { createFakeStripe, makeInvoice, makeSubscription, PRICES, RESELLER_PRICES } from './fakeStripe'
import type { BillingGate } from '../store'

const SECRET = 'whsec_test_0123456789abcdef0123456789abcdef'
const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

const config: StripeConfig = {
  secretKey: 'sk_test_abc123',
  webhookSecret: SECRET,
  mode: 'test',
  apiVersion: '2025-03-31.basil',
  envPrices: { ...PRICES },
  envResellerPrices: { agency: { ...RESELLER_PRICES.agency }, premium: { ...RESELLER_PRICES.premium } },
  appUrl: 'https://leadflow.example',
}

function setup(now = new Date('2026-11-20T10:00:00Z')) {
  const mem = createMemoryBillingStore()
  const stripe = createFakeStripe()
  let clock = now
  const deps: BillingDeps = { store: mem.store, stripe: stripe.gateway, config, now: () => clock }
  return { mem, stripe, deps, setNow: (d: Date) => (clock = d) }
}

function event(id: string, type: string, object: Record<string, unknown>, livemode = false): StripeEvent {
  return { id, object: 'event', type, created: 1_763_600_000, livemode, data: { object } }
}

const ctx = { orgId: ORG, userId: USER, email: 'admin@example.test' }

// ════════════════════════════════════════════════════════════════════════════
describe('firma webhook Stripe', () => {
  const body = JSON.stringify({ id: 'evt_TEST123456', object: 'event', type: 'invoice.paid', created: 1, livemode: false, data: { object: { id: 'in_1' } } })
  const now = 1_763_600_000

  it('accetta una firma valida sul body grezzo', () => {
    const ev = verifyStripeSignature(body, signPayload(body, SECRET, now), SECRET, { nowSeconds: now + 10 })
    expect(ev.id).toBe('evt_TEST123456')
  })
  it('rifiuta una firma con segreto diverso', () => {
    expect(() => verifyStripeSignature(body, signPayload(body, 'whsec_other', now), SECRET, { nowSeconds: now })).toThrow(SignatureError)
  })
  it('rifiuta un body modificato (anche solo riformattato)', () => {
    const header = signPayload(body, SECRET, now)
    const reformatted = JSON.stringify(JSON.parse(body), null, 2)
    expect(() => verifyStripeSignature(reformatted, header, SECRET, { nowSeconds: now })).toThrow('signature_mismatch')
  })
  it('rifiuta timestamp fuori tolleranza (replay)', () => {
    expect(() => verifyStripeSignature(body, signPayload(body, SECRET, now - 301), SECRET, { nowSeconds: now })).toThrow('timestamp_out_of_tolerance')
  })
  it('rifiuta header assente o malformato', () => {
    expect(() => verifyStripeSignature(body, null, SECRET)).toThrow('missing_signature')
    expect(() => verifyStripeSignature(body, 'v1=abc', SECRET)).toThrow('malformed_signature')
    expect(() => verifyStripeSignature(body, `t=${now},v0=${'a'.repeat(64)}`, SECRET, { nowSeconds: now })).toThrow('malformed_signature')
  })
  it('accetta se almeno una delle firme v1 è valida (rotazione del segreto)', () => {
    const good = signPayload(body, SECRET, now).split(',')[1]
    const header = `t=${now},v1=${'0'.repeat(64)},${good}`
    expect(verifyStripeSignature(body, header, SECRET, { nowSeconds: now }).type).toBe('invoice.paid')
  })
  it('rifiuta payload firmato ma non evento Stripe', () => {
    const fake = JSON.stringify({ hello: 'world' })
    expect(() => verifyStripeSignature(fake, signPayload(fake, SECRET, now), SECRET, { nowSeconds: now })).toThrow('invalid_payload')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('configurazione Stripe', () => {
  const base = { STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc', URL: 'https://app.example', STRIPE_PRICE_STARTER: 'price_TESTstarter01' }
  it('chiavi di test: configurato in modalità test', () => {
    const { config: c, state } = readStripeConfig(base)
    expect(state.configured).toBe(true)
    expect(c?.mode).toBe('test')
    expect(state.prices_configured).toEqual(['starter'])
  })
  it('chiave live senza approvazione esplicita: bloccata', () => {
    const { config: c, state } = readStripeConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc' })
    expect(c).toBe(null)
    expect(state.blocked).toContain('stripe_live_mode_not_approved')
  })
  it('chiave live con approvazione: modalità live', () => {
    const { config: c } = readStripeConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_LIVE_MODE_APPROVED: LIVE_APPROVAL_VALUE })
    expect(c?.mode).toBe('live')
  })
  it('chiave pubblicabile di modalità diversa e price non valido: bloccati', () => {
    const { state } = readStripeConfig({ ...base, STRIPE_PUBLISHABLE_KEY: 'pk_live_x', STRIPE_PRICE_BUSINESS: 'prod_123' })
    expect(state.blocked).toEqual(expect.arrayContaining(['stripe_publishable_key_mode_mismatch', 'stripe_price_business_invalid_format']))
  })
  it('chiave mancante', () => {
    expect(readStripeConfig({}).state.missing).toContain('STRIPE_SECRET_KEY')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('mapping Stripe → database', () => {
  it('codifica form annidata come richiesto da Stripe', () => {
    expect(encodeForm({ line_items: [{ price: 'price_1', quantity: 1 }], metadata: { organization_id: 'o' }, x: undefined })).toBe(
      'line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Borganization_id%5D=o',
    )
  })
  it('periodo dagli item (basil) o dall\'abbonamento (versioni precedenti)', () => {
    const sub = makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.starter, start: 1_000_000, end: 2_000_000 })
    expect(subscriptionPeriod(sub).start).toBe(new Date(1_000_000_000).toISOString())
    const legacy = { ...sub, items: { data: [{ ...sub.items.data[0]!, current_period_start: undefined, current_period_end: undefined }] }, current_period_start: 3_000_000, current_period_end: 4_000_000 }
    expect(subscriptionPeriod(legacy).end).toBe(new Date(4_000_000_000).toISOString())
  })
  it('piano dal Price ID: prima billing_plans, poi variabili d\'ambiente; prezzi sconosciuti → null', () => {
    const plans = TEST_PLANS.map((p) => (p.code === 'business' ? { ...p, stripe_price_id: 'price_DBbusiness01' } : p))
    expect(planForPriceId('price_DBbusiness01', plans, PRICES)).toBe('business')
    expect(planForPriceId(PRICES.enterprise, plans, PRICES)).toBe('enterprise')
    expect(planForPriceId('price_UNKNOWN0001', plans, PRICES)).toBe(null)
    expect(priceIdForPlan(plans[1]!, PRICES)).toBe('price_DBbusiness01')
    expect(priceIdForPlan(plans[0]!, {})).toBe(null)
  })
  it('fattura: abbonamento da parent (basil) o campo legacy; URL solo https', () => {
    const inv = makeInvoice({ id: 'in_TEST000001', customer: 'cus_X', subscription: 'sub_TESTa00001', status: 'paid', total: 18178, net: 14900, paid: 18178 })
    expect(invoiceSubscriptionId(inv)).toBe('sub_TESTa00001')
    expect(invoiceSubscriptionId({ ...inv, parent: null, subscription: 'sub_TESTlegacy1' })).toBe('sub_TESTlegacy1')
    const p = invoicePayload({ ...inv, hosted_invoice_url: 'javascript:alert(1)' }, ORG, new Date(), 'invoice.paid', 'evt_1')
    expect(p.hosted_invoice_url).toBe(null)
    expect(p.total_excluding_tax_cents).toBe(14900)
  })
  it('payload abbonamento con piano, importi e stato', () => {
    const sub = makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.business })
    const p = subscriptionPayload(sub, ORG, TEST_PLANS, PRICES, new Date('2026-11-20T10:00:00Z'), 'customer.subscription.updated')
    expect(p).toMatchObject({ plan_code: 'business', unit_amount_cents: 34900, status: 'active', billing_interval: 'month', stripe_customer_id: 'cus_TESTa00001' })
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('checkout, portale, upgrade/downgrade, cancellazione', () => {
  it('checkout: crea il customer una sola volta e restituisce la URL di Stripe Checkout', async () => {
    const { deps, stripe, mem } = setup()
    mem.orgNames.set(ORG, 'Alfa Srl')
    const r = await startCheckout(deps, ctx, 'starter')
    expect(r.url.startsWith('https://checkout.stripe.com/')).toBe(true)
    await startCheckout(deps, ctx, 'starter')
    expect(stripe.calls.filter((c) => c.op === 'createCustomer').length).toBe(1)
    const args = stripe.calls.find((c) => c.op === 'createCheckoutSession')!.args as { priceId: string; successUrl: string; organizationId: string }
    expect(args.priceId).toBe(PRICES.starter)
    expect(args.organizationId).toBe(ORG)
    expect(args.successUrl).toBe('https://leadflow.example/dashboard/billing?checkout=success')
    // Nessun abbonamento attivato dal checkout: arriva solo dal webhook.
    expect(mem.subs.size).toBe(0)
    expect(mem.audits.some((a) => a.action === 'checkout.started')).toBe(true)
  })
  it('checkout rifiutato se esiste già un abbonamento attivo', async () => {
    const { deps, mem } = setup()
    mem.customers.set(ORG, { stripe_customer_id: 'cus_TESTa00001', livemode: false })
    mem.subs.set('sub_TESTa00001', { organization_id: ORG, stripe_subscription_id: 'sub_TESTa00001', status: 'active', plan_code: 'starter', stripe_synced_at: '2026-01-01' })
    await expect(startCheckout(deps, ctx, 'business')).rejects.toMatchObject({ status: 409, code: 'subscription_exists' })
  })
  it('checkout: piano senza Price configurato o inesistente', async () => {
    const { deps } = setup()
    const noPrices: BillingDeps = { ...deps, config: { ...config, envPrices: {} } }
    await expect(startCheckout(noPrices, ctx, 'starter')).rejects.toMatchObject({ status: 409, code: 'plan_price_not_configured' })
    await expect(startCheckout(deps, ctx, 'platinum')).rejects.toMatchObject({ status: 404, code: 'plan_not_found' })
  })
  it('checkout: customer di test non riutilizzabile in live', async () => {
    const { deps, mem } = setup()
    mem.customers.set(ORG, { stripe_customer_id: 'cus_TESTa00001', livemode: false })
    await expect(startCheckout({ ...deps, config: { ...config, mode: 'live' } }, ctx, 'starter')).rejects.toMatchObject({ code: 'customer_mode_mismatch' })
  })
  it('portale: richiede un account di fatturazione', async () => {
    const { deps, mem } = setup()
    await expect(openPortal(deps, ctx)).rejects.toMatchObject({ code: 'no_billing_account' })
    mem.customers.set(ORG, { stripe_customer_id: 'cus_TESTa00001', livemode: false })
    expect((await openPortal(deps, ctx)).url).toMatch(/^https:\/\/billing\.stripe\.com\//)
  })

  function withActive(price: string, status: 'active' | 'past_due' = 'active') {
    const s = setup()
    s.mem.customers.set(ORG, { stripe_customer_id: 'cus_TESTa00001', livemode: false })
    const sub = makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price, status, org: ORG })
    s.stripe.subscriptions.set(sub.id, sub)
    s.mem.subs.set(sub.id, { organization_id: ORG, stripe_subscription_id: sub.id, stripe_customer_id: 'cus_TESTa00001', status, plan_code: 'x', stripe_synced_at: '2026-01-01T00:00:00.000Z' })
    return s
  }
  it('upgrade: addebito pro-rata immediato e stato applicato da Stripe', async () => {
    const { deps, stripe, mem } = withActive(PRICES.starter)
    const r = await changePlan(deps, ctx, 'enterprise')
    expect(r.direction).toBe('upgrade')
    const call = stripe.calls.find((c) => c.op === 'updateSubscriptionPrice')!.args as { prorationBehavior: string }
    expect(call.prorationBehavior).toBe('always_invoice')
    expect(mem.subs.get('sub_TESTa00001')!.plan_code).toBe('enterprise')
  })
  it('downgrade: credito pro-rata sulla prossima fattura', async () => {
    const { deps, stripe, mem } = withActive(PRICES.enterprise)
    const r = await changePlan(deps, ctx, 'starter')
    expect(r.direction).toBe('downgrade')
    expect((stripe.calls.find((c) => c.op === 'updateSubscriptionPrice')!.args as { prorationBehavior: string }).prorationBehavior).toBe('create_prorations')
    expect(mem.subs.get('sub_TESTa00001')!.plan_code).toBe('starter')
  })
  it('cambio piano: stesso piano e pagamento in sospeso rifiutati', async () => {
    await expect(changePlan(withActive(PRICES.starter).deps, ctx, 'starter')).rejects.toMatchObject({ code: 'same_plan' })
    await expect(changePlan(withActive(PRICES.starter, 'past_due').deps, ctx, 'business')).rejects.toMatchObject({ code: 'subscription_not_changeable' })
  })
  it('cancellazione a fine periodo e ripristino', async () => {
    const { deps, mem } = withActive(PRICES.business)
    expect((await setCancellation(deps, ctx, 'cancel')).cancel_at_period_end).toBe(true)
    expect(mem.subs.get('sub_TESTa00001')!.cancel_at_period_end).toBe(true)
    await expect(setCancellation(deps, ctx, 'cancel')).rejects.toMatchObject({ code: 'already_cancelling' })
    expect((await setCancellation(deps, ctx, 'resume')).cancel_at_period_end).toBe(false)
  })
  it('errore Stripe temporaneo → 503 senza dettagli interni', async () => {
    const { deps, stripe } = setup()
    stripe.failNextWith(new StripeApiError(500, 'api_error', null, true))
    await expect(startCheckout(deps, ctx, 'starter')).rejects.toMatchObject({ status: 503, code: 'stripe_unavailable' })
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('webhook: elaborazione eventi', () => {
  function withCustomer() {
    const s = setup()
    s.mem.customers.set(ORG, { stripe_customer_id: 'cus_TESTa00001', livemode: false })
    return s
  }

  it('checkout.session.completed → abbonamento attivo con il piano corretto', async () => {
    const { deps, stripe, mem } = withCustomer()
    stripe.subscriptions.set('sub_TESTa00001', makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.business, org: ORG }))
    stripe.sessions.set('cs_test_1', { id: 'cs_test_1', object: 'checkout.session', url: null, mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_TESTa00001', subscription: 'sub_TESTa00001', client_reference_id: ORG, metadata: {}, livemode: false })
    const r = await processWebhookEvent(deps, event('evt_TEST000001', 'checkout.session.completed', { id: 'cs_test_1' }))
    expect(r).toMatchObject({ http: 200, status: 'processed' })
    expect(mem.subs.get('sub_TESTa00001')).toMatchObject({ organization_id: ORG, plan_code: 'business', status: 'active' })
    expect(mem.events.get('evt_TEST000001')).toMatchObject({ status: 'processed', org: ORG })
  })

  it('evento duplicato: nessuna seconda elaborazione', async () => {
    const { deps, stripe, mem } = withCustomer()
    stripe.subscriptions.set('sub_TESTa00001', makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.starter }))
    const ev = event('evt_TEST000002', 'customer.subscription.created', { id: 'sub_TESTa00001' })
    await processWebhookEvent(deps, ev)
    const calls = stripe.calls.length
    expect(await processWebhookEvent(deps, ev)).toMatchObject({ http: 200, status: 'duplicate' })
    expect(stripe.calls.length).toBe(calls)
    expect(mem.applyCount()).toBe(1)
  })

  it('evento fuori ordine: un evento vecchio porta allo stato CORRENTE letto da Stripe', async () => {
    const { deps, stripe, mem, setNow } = withCustomer()
    const sub = makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.enterprise })
    stripe.subscriptions.set(sub.id, sub)
    // Arriva prima l'evento più recente (upgrade a Enterprise)...
    setNow(new Date('2026-11-20T10:00:05Z'))
    await processWebhookEvent(deps, event('evt_TEST000004', 'customer.subscription.updated', { id: sub.id, items: { data: [{ price: { id: PRICES.enterprise } }] } }))
    // ...poi quello vecchio (payload con il piano Starter): il payload è ignorato, si rilegge Stripe.
    setNow(new Date('2026-11-20T10:00:09Z'))
    await processWebhookEvent(deps, event('evt_TEST000003', 'customer.subscription.created', { id: sub.id, items: { data: [{ price: { id: PRICES.starter } }] } }))
    expect(mem.subs.get(sub.id)!.plan_code).toBe('enterprise')
  })

  it('stato letto prima di quello salvato: scartato (corsa tra elaborazioni parallele)', async () => {
    const { deps, stripe, mem, setNow } = withCustomer()
    const sub = makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.enterprise })
    stripe.subscriptions.set(sub.id, sub)
    setNow(new Date('2026-11-20T10:00:10Z'))
    await processWebhookEvent(deps, event('evt_TEST000010', 'customer.subscription.updated', { id: sub.id }))
    stripe.subscriptions.set(sub.id, { ...sub, status: 'incomplete', items: { data: [{ ...sub.items.data[0]!, price: { ...sub.items.data[0]!.price, id: PRICES.starter } }] } })
    setNow(new Date('2026-11-20T10:00:01Z'))
    await processWebhookEvent(deps, event('evt_TEST000011', 'customer.subscription.updated', { id: sub.id }))
    expect(mem.subs.get(sub.id)).toMatchObject({ plan_code: 'enterprise', status: 'active' })
  })

  it('invoice.payment_failed → fattura aperta salvata e abbonamento past_due', async () => {
    const { deps, stripe, mem } = withCustomer()
    stripe.subscriptions.set('sub_TESTa00001', makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.starter, status: 'past_due' }))
    stripe.invoices.set('in_TEST000001', makeInvoice({ id: 'in_TEST000001', customer: 'cus_TESTa00001', subscription: 'sub_TESTa00001', status: 'open', total: 18178, net: 14900, paid: 0, attempt: 2 }))
    expect(await processWebhookEvent(deps, event('evt_TEST000005', 'invoice.payment_failed', { id: 'in_TEST000001' }))).toMatchObject({ status: 'processed' })
    expect(mem.invoices.get('in_TEST000001')).toMatchObject({ status: 'open', attempt_count: 2, event_type: 'invoice.payment_failed', paid_at: null })
    expect(mem.subs.get('sub_TESTa00001')!.status).toBe('past_due')
  })

  it('invoice.paid (rinnovo) → fattura pagata e nuovo periodo', async () => {
    const { deps, stripe, mem } = withCustomer()
    stripe.subscriptions.set('sub_TESTa00001', makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.starter, start: 1_766_192_000, end: 1_768_870_400 }))
    stripe.invoices.set('in_TEST000002', makeInvoice({ id: 'in_TEST000002', customer: 'cus_TESTa00001', subscription: 'sub_TESTa00001', status: 'paid', total: 18178, net: 14900, paid: 18178 }))
    await processWebhookEvent(deps, event('evt_TEST000006', 'invoice.paid', { id: 'in_TEST000002' }))
    expect(mem.invoices.get('in_TEST000002')).toMatchObject({ status: 'paid', amount_paid_cents: 18178, total_excluding_tax_cents: 14900 })
    expect(mem.subs.get('sub_TESTa00001')!.current_period_start).toBe(new Date(1_766_192_000_000).toISOString())
  })

  it('customer.subscription.deleted → abbonamento cancellato', async () => {
    const { deps, stripe, mem } = withCustomer()
    stripe.subscriptions.set('sub_TESTa00001', { ...makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.starter, status: 'canceled' }), ended_at: 1_763_700_000 })
    await processWebhookEvent(deps, event('evt_TEST000007', 'customer.subscription.deleted', { id: 'sub_TESTa00001' }))
    expect(mem.subs.get('sub_TESTa00001')).toMatchObject({ status: 'canceled', ended_at: new Date(1_763_700_000_000).toISOString() })
  })

  it('customer sconosciuto o org nei metadata diversa: evento ignorato, nessuna scrittura', async () => {
    const { deps, stripe, mem } = withCustomer()
    stripe.subscriptions.set('sub_TESTzz0001', makeSubscription({ id: 'sub_TESTzz0001', customer: 'cus_TESTstranger', price: PRICES.enterprise }))
    expect(await processWebhookEvent(deps, event('evt_TEST000008', 'customer.subscription.created', { id: 'sub_TESTzz0001' }))).toMatchObject({ status: 'ignored', reason: 'unknown_customer' })
    stripe.subscriptions.set('sub_TESTzz0002', makeSubscription({ id: 'sub_TESTzz0002', customer: 'cus_TESTa00001', price: PRICES.enterprise, org: OTHER_ORG }))
    expect(await processWebhookEvent(deps, event('evt_TEST000009', 'customer.subscription.created', { id: 'sub_TESTzz0002' }))).toMatchObject({ status: 'ignored', reason: 'organization_mismatch' })
    expect(mem.subs.size).toBe(0)
  })

  it('evento live con chiavi di test: ignorato', async () => {
    const { deps, mem } = withCustomer()
    expect(await processWebhookEvent(deps, event('evt_TEST000012', 'invoice.paid', { id: 'in_x' }, true))).toMatchObject({ status: 'ignored', reason: 'livemode_mismatch' })
    expect(mem.invoices.size).toBe(0)
  })

  it('Stripe non raggiungibile → 500 (Stripe ritenta) e il retry va a buon fine', async () => {
    const { deps, stripe, mem } = withCustomer()
    stripe.subscriptions.set('sub_TESTa00001', makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.starter }))
    stripe.failNextWith(new StripeApiError(0, 'network_error', null, true))
    const ev = event('evt_TEST000013', 'customer.subscription.updated', { id: 'sub_TESTa00001' })
    expect(await processWebhookEvent(deps, ev)).toMatchObject({ http: 500, status: 'failed' })
    expect(mem.events.get('evt_TEST000013')!.status).toBe('failed')
    expect(await processWebhookEvent(deps, ev)).toMatchObject({ http: 200, status: 'processed' })
    expect(mem.events.get('evt_TEST000013')!.attempts).toBe(2)
  })

  it('evento in elaborazione altrove → 409 (Stripe ritenta più tardi)', async () => {
    const { deps, mem } = withCustomer()
    mem.events.set('evt_TEST000014', { status: 'processing', attempts: 1, error: null, org: null })
    expect(await processWebhookEvent(deps, event('evt_TEST000014', 'invoice.paid', { id: 'in_x' }))).toMatchObject({ http: 409 })
  })

  it('tipi di evento non gestiti: ignorati con 200', async () => {
    const { deps } = withCustomer()
    expect(await processWebhookEvent(deps, event('evt_TEST000015', 'charge.refunded', { id: 'ch_1' }))).toMatchObject({ http: 200, status: 'ignored', reason: 'event_not_handled' })
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('controllo funzionalità (canUseFeature) ed errori di billing', () => {
  const gate = (allowed: boolean, reason: string): BillingGate => ({
    canUseFeature: async () => ({ allowed, reason, plan_code: 'starter' }),
    leadQuota: async () => ({ enforced: true, allowed: true }),
    countNewLeads: async () => ({ enforced: true, counted: 0, already_counted: 0, over_quota_refs: [] }),
    recordProviderCall: async () => undefined,
  })
  it('funzionalità non inclusa → 402 billing_feature_not_in_plan', async () => {
    await expect(requireFeature(gate(false, 'feature_not_in_plan'), ORG, 'ai_sales_agent')).rejects.toMatchObject({ status: 402, code: 'billing_feature_not_in_plan' })
    await expect(requireFeature(gate(true, 'ok'), ORG, 'lead_finder')).resolves.toBe(undefined)
  })
  it('errori dei trigger SQL convertiti in 402 con dettagli sicuri', () => {
    const e = billingDbError({ message: 'billing_insufficient_credits', details: '{"remaining":0,"limit":500,"credits":3,"secret":"x"}', code: 'P0001' })
    expect(e).toBeInstanceOf(HttpError)
    expect(e).toMatchObject({ status: 402, code: 'billing_insufficient_credits', details: { remaining: 0, limit: 500, credits: 3 } })
    expect(e!.details).not.toHaveProperty('secret')
    expect(billingDbError({ message: 'duplicate key value', code: '23505' })).toBe(null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('client REST Stripe', () => {
  it('invia versione API fissata, chiave, Idempotency-Key e body form-encoded', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ id: 'cus_TESTnew0001', livemode: false }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const gw = createStripeGateway({ secretKey: 'sk_test_abc', apiVersion: '2025-03-31.basil' }, { fetchImpl })
    await gw.createCustomer({ organizationId: ORG, name: 'Alfa Srl', email: null }, 'leadflow-customer-x')
    const h = seen[0]!.init.headers as Record<string, string>
    expect(seen[0]!.url).toBe('https://api.stripe.com/v1/customers')
    expect(h['stripe-version']).toBe('2025-03-31.basil')
    expect(h['idempotency-key']).toBe('leadflow-customer-x')
    expect(h.authorization).toBe('Bearer sk_test_abc')
    expect(String(seen[0]!.init.body)).toBe(`name=Alfa%20Srl&metadata%5Borganization_id%5D=${ORG}`)
  })
  it('errori: 4xx non ritentabili, 429/5xx/rete ritentabili', async () => {
    const respond = (status: number) => (async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing' } }), { status })) as unknown as typeof fetch
    await expect(createStripeGateway({ secretKey: 'sk_test_a', apiVersion: 'v' }, { fetchImpl: respond(404) }).retrieveSubscription('sub_x')).rejects.toMatchObject({ status: 404, retryable: false, stripeCode: 'resource_missing' })
    await expect(createStripeGateway({ secretKey: 'sk_test_a', apiVersion: 'v' }, { fetchImpl: respond(503) }).retrieveSubscription('sub_x')).rejects.toMatchObject({ retryable: true })
    const offline = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(createStripeGateway({ secretKey: 'sk_test_a', apiVersion: 'v' }, { fetchImpl: offline }).retrieveInvoice('in_x')).rejects.toMatchObject({ type: 'network_error', retryable: true })
  })
})

describe('webhook end-to-end: richiesta firmata → verifica → elaborazione', () => {
  it('firma valida elaborata; firma non valida respinta prima di qualsiasi scrittura', async () => {
    const { deps, stripe, mem } = setup()
    mem.customers.set(ORG, { stripe_customer_id: 'cus_TESTa00001', livemode: false })
    stripe.subscriptions.set('sub_TESTa00001', makeSubscription({ id: 'sub_TESTa00001', customer: 'cus_TESTa00001', price: PRICES.starter }))
    const raw = JSON.stringify(event('evt_TEST000100', 'customer.subscription.created', { id: 'sub_TESTa00001' }))
    const now = Math.floor(Date.now() / 1000)
    const ok = verifyStripeSignature(raw, signPayload(raw, SECRET, now), SECRET)
    expect(await processWebhookEvent(deps, ok)).toMatchObject({ http: 200, status: 'processed' })
    expect(() => verifyStripeSignature(raw, signPayload(raw, 'whsec_attacker', now), SECRET)).toThrow('signature_mismatch')
    expect(mem.events.size).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('White Label: abbonamenti dei rivenditori (Stripe test, gateway simulato)', () => {
  const RES = '44444444-4444-4444-8444-444444444444'
  const rctx = { resellerId: RES, userId: USER, email: 'anna@agenzia.test' }
  function withReseller(over: Record<string, unknown> = {}) {
    const s = setup()
    s.mem.resellers.set(RES, { id: RES, name: 'Agenzia Alfa', plan_code: 'agency', status: 'active', stripe_customer_id: null, stripe_customer_livemode: null, had_stripe_subscription: false, current: null, ...over } as never)
    return s
  }

  it('primo checkout: canone mensile + quota di attivazione, customer creato una volta', async () => {
    const { deps, stripe, mem } = withReseller()
    const r = await startResellerCheckout(deps, rctx)
    expect(r.includes_setup_fee).toBe(true)
    const args = stripe.calls.find((c) => c.op === 'createResellerCheckoutSession')!.args as { lineItems: { price: string }[]; successUrl: string; resellerId: string }
    expect(args.lineItems.map((l) => l.price)).toEqual([RESELLER_PRICES.agency.monthly, RESELLER_PRICES.agency.setup])
    expect(args.successUrl).toBe('https://leadflow.example/reseller?checkout=success')
    expect(mem.resellers.get(RES)!.stripe_customer_id).toMatch(/^cus_TESTres/)
    // Nessun abbonamento creato dal checkout: arriva solo dal webhook.
    expect(mem.resellerSubs.size).toBe(0)
  })
  it('la quota di attivazione non si ripaga dopo un abbonamento precedente', async () => {
    const { deps, stripe } = withReseller({ had_stripe_subscription: true, stripe_customer_id: 'cus_TESTres0009', stripe_customer_livemode: false })
    const r = await startResellerCheckout(deps, rctx)
    expect(r.includes_setup_fee).toBe(false)
    expect((stripe.calls.find((c) => c.op === 'createResellerCheckoutSession')!.args as { lineItems: unknown[] }).lineItems).toHaveLength(1)
    expect(stripe.calls.some((c) => c.op === 'createResellerCustomer')).toBe(false)
  })
  it('rifiuti: rivenditore sospeso, abbonamento esistente, prezzi non configurati', async () => {
    await expect(startResellerCheckout(withReseller({ status: 'suspended' }).deps, rctx)).rejects.toMatchObject({ code: 'reseller_suspended' })
    await expect(startResellerCheckout(withReseller({ current: { source: 'external', status: 'active', stripe_subscription_id: null } }).deps, rctx)).rejects.toMatchObject({ code: 'subscription_exists' })
    const s = withReseller()
    await expect(startResellerCheckout({ ...s.deps, config: { ...config, envResellerPrices: { agency: { monthly: RESELLER_PRICES.agency.monthly } } } }, rctx)).rejects.toMatchObject({ code: 'setup_price_not_configured' })
    await expect(startResellerCheckout({ ...s.deps, config: { ...config, envResellerPrices: {} } }, rctx)).rejects.toMatchObject({ code: 'plan_price_not_configured' })
  })
  it('portale: solo con account di fatturazione', async () => {
    await expect(openResellerPortal(withReseller().deps, rctx)).rejects.toMatchObject({ code: 'no_billing_account' })
    const { deps } = withReseller({ stripe_customer_id: 'cus_TESTres0009', stripe_customer_livemode: false })
    expect((await openResellerPortal(deps, rctx)).url).toMatch(/^https:\/\/billing\.stripe\.com\//)
  })

  it('webhook: abbonamento e fatture del rivenditore instradati senza toccare le organizzazioni', async () => {
    const { deps, stripe, mem } = withReseller({ stripe_customer_id: 'cus_TESTres0001', stripe_customer_livemode: false })
    stripe.subscriptions.set('sub_TESTres0001', makeSubscription({ id: 'sub_TESTres0001', customer: 'cus_TESTres0001', price: RESELLER_PRICES.agency.monthly }))
    stripe.sessions.set('cs_test_rx', { id: 'cs_test_rx', object: 'checkout.session', url: null, mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_TESTres0001', subscription: 'sub_TESTres0001', client_reference_id: RES, metadata: {}, livemode: false })
    expect(await processWebhookEvent(deps, event('evt_TESTres001', 'checkout.session.completed', { id: 'cs_test_rx' }))).toMatchObject({ http: 200, status: 'processed' })
    expect(mem.resellerSubs.get('sub_TESTres0001')).toMatchObject({ reseller_id: RES, plan_code: 'agency', status: 'active', unit_amount_cents: 39900 })
    expect(mem.subs.size).toBe(0)
    expect(mem.events.get('evt_TESTres001')!.org).toBe(null)

    stripe.invoices.set('in_TESTres0001', makeInvoice({ id: 'in_TESTres0001', customer: 'cus_TESTres0001', subscription: 'sub_TESTres0001', status: 'paid', total: 413558, net: 338900, paid: 413558 }))
    await processWebhookEvent(deps, event('evt_TESTres002', 'invoice.paid', { id: 'in_TESTres0001' }))
    expect(mem.resellerInvoices.get('in_TESTres0001')).toMatchObject({ reseller_id: RES, status: 'paid', total_excluding_tax_cents: 338900 })
    expect(mem.resellerInvoices.get('in_TESTres0001')).not.toHaveProperty('organization_id')
    expect(mem.invoices.size).toBe(0)
  })
  it('webhook: metadati con un altro rivenditore → evento ignorato', async () => {
    const { deps, stripe, mem } = withReseller({ stripe_customer_id: 'cus_TESTres0001', stripe_customer_livemode: false })
    const sub = makeSubscription({ id: 'sub_TESTres0002', customer: 'cus_TESTres0001', price: RESELLER_PRICES.premium.monthly })
    sub.metadata = { reseller_id: '55555555-5555-4555-8555-555555555555' }
    stripe.subscriptions.set(sub.id, sub)
    expect(await processWebhookEvent(deps, event('evt_TESTres003', 'customer.subscription.updated', { id: sub.id }))).toMatchObject({ status: 'ignored', reason: 'reseller_mismatch' })
    expect(mem.resellerSubs.size).toBe(0)
  })
})
