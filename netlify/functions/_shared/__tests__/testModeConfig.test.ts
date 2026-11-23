import { describe, expect, it, vi } from 'vitest'
import { supabaseAnonKey, supabaseServiceKey, supabaseUrl } from '../env'
import { callStructured, openaiBaseUrl } from '../lead-finder/analysis/openai'
import { integrationStatus } from '../launch/integrations'
import { envForTier } from '../agents/models'

describe('variabili Supabase lato server', () => {
  it('accetta i nomi delle nuove chiavi Supabase (configurazione Netlify attuale)', () => {
    const env = { VITE_SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', SUPABASE_SECRET_KEY: 'sb_secret_y' }
    expect(supabaseUrl(env)).toBe('https://ref.supabase.co')
    expect(supabaseAnonKey(env)).toBe('sb_publishable_x')
    expect(supabaseServiceKey(env)).toBe('sb_secret_y')
    expect(integrationStatus(env).find((i) => i.key === 'supabase')?.state).toBe('configured')
  })
  it('i nomi classici hanno la precedenza', () => {
    const env = { SUPABASE_URL: 'https://a.supabase.co', VITE_SUPABASE_URL: 'https://b.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_SECRET_KEY: 'new', SUPABASE_ANON_KEY: 'anon', SUPABASE_PUBLISHABLE_KEY: 'pub' }
    expect(supabaseUrl(env)).toBe('https://a.supabase.co')
    expect(supabaseServiceKey(env)).toBe('svc')
    expect(supabaseAnonKey(env)).toBe('anon')
  })
  it('la chiave segreta non viene mai letta da variabili VITE_ (pubbliche)', () => {
    expect(supabaseServiceKey({ VITE_SUPABASE_SERVICE_ROLE_KEY: 'leak', VITE_SUPABASE_SECRET_KEY: 'leak' })).toBeUndefined()
  })
  it('valori vuoti o solo spazi sono ignorati', () => {
    expect(supabaseServiceKey({ SUPABASE_SERVICE_ROLE_KEY: '  ', SUPABASE_SECRET_KEY: 'k' })).toBe('k')
    expect(integrationStatus({}).find((i) => i.key === 'supabase')?.state).toBe('missing')
  })
})

describe('base URL OpenAI (Netlify AI Gateway)', () => {
  it('usa OPENAI_BASE_URL quando presente, altrimenti api.openai.com', () => {
    expect(openaiBaseUrl({ OPENAI_BASE_URL: 'https://gw.example/openai/v1/' })).toBe('https://gw.example/openai/v1')
    expect(openaiBaseUrl({})).toBe('https://api.openai.com/v1')
    expect(openaiBaseUrl({ OPENAI_BASE_URL: 'http://insecure' })).toBe('https://api.openai.com/v1')
  })
  it('callStructured invia la richiesta al base URL indicato', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }))
    const r = await callStructured({ apiKey: 'k', model: 'm', system: 's', user: 'u', schemaName: 'x', schema: {}, timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'https://gw.example/v1' })
    expect(r.json).toEqual({ ok: true })
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe('https://gw.example/v1/responses')
  })
  it('envForTier propaga OPENAI_BASE_URL ai moduli riusati', () => {
    const { env } = envForTier('standard', { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm', OPENAI_BASE_URL: 'https://gw.example/v1' })
    expect(env.OPENAI_BASE_URL).toBe('https://gw.example/v1')
  })
})
