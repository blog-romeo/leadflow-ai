import { describe, expect, it } from 'vitest'
import { createStripeGateway } from '../stripeClient'
import { readStripeConfig } from '../config'

async function sessionBody(automaticTax: boolean | undefined): Promise<string> {
  let body = ''
  const gw = createStripeGateway(
    { secretKey: 'sk_test_abc', apiVersion: '2025-03-31.basil', automaticTax },
    {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = decodeURIComponent(String(init.body))
        return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    },
  )
  await gw.createCheckoutSession({ customerId: 'cus_TEST1', priceId: 'price_TEST1', organizationId: 'o', planCode: 'starter', successUrl: 'https://a.it/s', cancelUrl: 'https://a.it/c' }, 'k')
  return body
}

describe('IVA nel Checkout', () => {
  it('di default Stripe Tax non è richiesto (nessun automatic_tax)', async () => {
    const b = await sessionBody(undefined)
    expect(b.includes('automatic_tax')).toBe(false)
    expect(b).toContain('tax_id_collection[enabled]=true')
  })
  it('con STRIPE_AUTOMATIC_TAX=true Stripe calcola l’IVA', async () => {
    expect(await sessionBody(true)).toContain('automatic_tax[enabled]=true')
  })
  it('la variabile viene letta dalla configurazione', () => {
    const env = { STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abcdef', STRIPE_PRICE_STARTER: 'price_ABCDEF1', URL: 'https://a.it' }
    expect(readStripeConfig({ ...env, STRIPE_AUTOMATIC_TAX: 'true' }).config?.automaticTax).toBe(true)
    expect(readStripeConfig(env).config?.automaticTax).toBe(false)
  })
})
