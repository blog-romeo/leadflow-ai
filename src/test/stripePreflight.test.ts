import { EXPECTED_PLANS, EXPECTED_RESELLER, REQUIRED_EVENTS, checkPortal, checkPrice, checkTax, checkWebhooks, keyMode, runPreflight } from '../../scripts/stripe-preflight.mjs'
import { PLANS, RESELLER_PLANS } from '../config/plans'

const price = (o: Record<string, unknown> = {}) => ({ id: 'price_x', active: true, livemode: false, currency: 'eur', unit_amount: 14900, type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, tax_behavior: 'exclusive', ...o })
const errors = <T extends { level: string }>(i: T[]): T[] => i.filter((x) => x.level === 'error')

describe('preflight Stripe (solo lettura, solo test)', () => {
  it('importi attesi identici alla configurazione pubblica', () => {
    expect(PLANS.map((p) => [p.code, p.priceCents])).toEqual(Object.entries(EXPECTED_PLANS))
    expect(RESELLER_PLANS.map((p) => [p.code, { monthly: p.monthlyPriceCents, setup: p.setupFeeCents }])).toEqual(Object.entries(EXPECTED_RESELLER))
  })
  it('rifiuta le chiavi live', async () => {
    expect(keyMode('sk_live_abc')).toBe('live')
    let called = false
    const r = await runPreflight({ STRIPE_SECRET_KEY: 'sk_live_abc' }, (async () => { called = true; return new Response('{}') }) as typeof fetch)
    expect(called).toBe(false)
    expect(r[0]!.issues[0]!.level).toBe('error')
  })
  it('Price corretto: nessun errore', () => expect(errors(checkPrice(price(), { amount: 14900, kind: 'recurring', automaticTax: true }))).toEqual([]))
  it('Price errato: importo, valuta, intervallo, IVA inclusa', () => {
    const e = errors(checkPrice(price({ unit_amount: 14999, currency: 'usd', recurring: { interval: 'year' }, tax_behavior: 'inclusive' }), { amount: 14900, kind: 'recurring', automaticTax: false }))
    expect(e).toHaveLength(4)
  })
  it('tax_behavior non specificato: avviso senza Stripe Tax, errore con Stripe Tax', () => {
    expect(errors(checkPrice(price({ tax_behavior: 'unspecified' }), { amount: 14900, kind: 'recurring', automaticTax: false }))).toHaveLength(0)
    expect(errors(checkPrice(price({ tax_behavior: 'unspecified' }), { amount: 14900, kind: 'recurring', automaticTax: true }))).toHaveLength(1)
  })
  it('webhook: URL, stato ed eventi', () => {
    const ok = [{ url: 'https://lf.it/.netlify/functions/stripe-webhook', status: 'enabled', livemode: false, enabled_events: REQUIRED_EVENTS }]
    expect(errors(checkWebhooks(ok, 'https://lf.it'))).toEqual([])
    expect(errors(checkWebhooks([{ ...ok[0], enabled_events: ['invoice.paid'] }], 'https://lf.it'))[0]!.msg).toContain('checkout.session.completed')
    expect(errors(checkWebhooks([], 'https://lf.it'))).toHaveLength(1)
  })
  it('portale: disdetta immediata segnalata come errore', () => {
    expect(errors(checkPortal([]))).toHaveLength(1)
    const cfg = { is_default: true, active: true, features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'immediately' } } }
    expect(errors(checkPortal([cfg]))).toHaveLength(1)
  })
  it('Stripe Tax: attivo solo con registrazione italiana', () => {
    expect(errors(checkTax({ status: 'pending' }, [], true))).toHaveLength(2)
    expect(errors(checkTax({ status: 'active' }, [{ status: 'active', country: 'IT' }], true))).toEqual([])
    expect(checkTax(null, [], false)[0]!.level).toBe('warn')
  })
  it('esecuzione completa con API simulata: solo richieste GET', async () => {
    const methods: string[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      const u = String(url)
      const body = u.includes('/prices/') ? price({ unit_amount: u.includes('BUS') ? 34900 : u.includes('ENT') ? 79900 : 14900 })
        : u.includes('webhook_endpoints') ? { data: [{ url: 'https://lf.it/.netlify/functions/stripe-webhook', status: 'enabled', livemode: false, enabled_events: ['*'] }] }
        : u.includes('billing_portal') ? { data: [{ is_default: true, active: true, features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true } } }] }
        : u.includes('tax/settings') ? { status: 'pending' } : { data: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const r = await runPreflight({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_PRICE_STARTER: 'price_STA', STRIPE_PRICE_BUSINESS: 'price_BUS', STRIPE_PRICE_ENTERPRISE: 'price_ENT', SITE_URL: 'https://lf.it' }, fake)
    expect(methods.every((m) => m === 'GET')).toBe(true)
    expect(r.flatMap((x) => x.issues).filter((i) => i.level === 'error')).toEqual([])
  })
})
