// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { checkConfig, runIntegrationPreflight } from '../../scripts/integration-preflight.mjs'

const STAGING = {
  SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon',
  STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_x',
  OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'modello-configurato', OPENAI_PRICE_INPUT_PER_MTOK: '1', OPENAI_PRICE_OUTPUT_PER_MTOK: '2',
  OVERPASS_API_URL: 'https://overpass.example/api/interpreter', OVERPASS_CONTACT: 'ops@example.test',
  LEADFLOW_INTERNAL_SECRET: 'x'.repeat(40), APP_URL: 'https://staging.example',
}

describe('preflight integrazioni (solo lettura)', () => {
  it('configurazione completa di staging: nessun errore', () => {
    expect(checkConfig(STAGING).filter((i) => i.level === 'error')).toEqual([])
  })
  it('chiave Stripe live rifiutata e segreti mai stampati', () => {
    const r = checkConfig({ ...STAGING, STRIPE_SECRET_KEY: 'sk_live_SEGRETO' })
    expect(r.some((i) => i.area === 'stripe' && i.level === 'error')).toBe(true)
    expect(JSON.stringify(r)).not.toContain('SEGRETO')
  })
  it('progetti Supabase diversi tra server e browser rilevati', () => {
    expect(checkConfig({ ...STAGING, VITE_SUPABASE_URL: 'https://altro.supabase.co' }).some((i) => i.level === 'error')).toBe(true)
  })
  it('senza PREFLIGHT_NETWORK nessuna chiamata di rete', async () => {
    let calls = 0
    const r = await runIntegrationPreflight(STAGING, (async () => { calls++; return new Response('{}') }) as typeof fetch)
    expect([r.network_checks, calls]).toEqual([false, 0])
  })
  it('con PREFLIGHT_NETWORK=1: migrazione mancante e modello non disponibile segnalati', async () => {
    const urls: string[] = []
    const fake = (async (url: string) => {
      urls.push(url)
      if (url.endsWith('/rpc/sa_ai_monitoring')) return new Response(JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' }), { status: 404 })
      if (url.includes('/rpc/')) return new Response(JSON.stringify({ code: '42501', message: 'forbidden' }), { status: 403 })
      if (url.includes('api.openai.com')) return new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 404 })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const r = await runIntegrationPreflight({ ...STAGING, PREFLIGHT_NETWORK: '1' }, fake)
    expect(r.issues.some((i) => i.msg.includes('migrazione 0013 non applicata'))).toBe(true)
    expect(r.issues.some((i) => i.area === 'openai' && i.level === 'error')).toBe(true)
    expect(r.issues.some((i) => i.msg.includes('RPC ai_agent_spend presente'))).toBe(true)
    // Nessuna chiamata a Stripe e nessuna generazione AI.
    expect(urls.some((u) => u.includes('stripe.com') || u.includes('/responses') || u.includes('/chat/'))).toBe(false)
  })
})
