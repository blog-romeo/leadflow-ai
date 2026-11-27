// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'

/** Autenticazione degli endpoint Demand Hunter: token obbligatorio, appartenenza all'organizzazione, input validato. */
const state = { user: { id: '22222222-2222-4222-8222-222222222222' } as { id: string } | null, membership: null as { role: string } | null }
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: state.user ? null : { message: 'invalid' } }) },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: state.membership, error: null }) }
      return q
    },
    rpc: async () => ({ data: { allowed: false, reason: 'no_subscription' }, error: null }),
  }),
}))

const ORG = '11111111-1111-4111-8111-111111111111'
const estimateHandler = (await import('../../../demand-hunter-estimate')).default
const startHandler = (await import('../../../demand-hunter-start')).default
const statusHandler = (await import('../../../demand-hunter-status')).default
const crmHandler = (await import('../../../demand-hunter-crm')).default

const post = (body: unknown, token?: string) =>
  new Request('https://app.example/api/demand-hunter/estimate', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
const hunt = { organization_id: ORG, action: 'hunt', goal: 'clienti', seed: 'Laravel', budget: 5 }

describe('Demand Hunter: autenticazione e controllo accessi', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://x.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
    state.user = { id: '22222222-2222-4222-8222-222222222222' }
    state.membership = null
  })
  it('senza token → 401', async () => {
    const r = await estimateHandler(post(hunt))
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: 'missing_token' })
  })
  it('token non valido → 401', async () => {
    state.user = null
    expect((await estimateHandler(post(hunt, 'bad'))).status).toBe(401)
  })
  it('utente di un\'altra organizzazione → 403 (stessa risposta di un\'org inesistente)', async () => {
    expect((await estimateHandler(post(hunt, 'ok'))).status).toBe(403)
    expect((await startHandler(post({ ...hunt, confirm_token: 'a'.repeat(43) }, 'ok'))).status).toBe(403)
    expect((await crmHandler(post({ organization_id: ORG, lead_ids: [ORG] }, 'ok'))).status).toBe(403)
  })
  it('membro senza piano con il Lead Finder → 402', async () => {
    state.membership = { role: 'member' }
    const r = await estimateHandler(post(hunt, 'ok'))
    expect(r.status).toBe(402)
    expect((await r.json()).error).toBe('billing_no_subscription')
  })
  it('input non valido → 400 prima di qualsiasi accesso', async () => {
    expect((await estimateHandler(post({ ...hunt, budget: 9999 }, 'ok'))).status).toBe(400)
    expect((await startHandler(post(hunt, 'ok'))).status).toBe(400)
  })
  it('metodo sbagliato → 405', async () => {
    expect((await statusHandler(post(hunt, 'ok'))).status).toBe(405)
  })
  it('nessuna risposta espone segreti o chiavi', async () => {
    process.env.DEMAND_HUNTER_SERVICE_SECRET = 'segreto-di-prova-'.repeat(3)
    state.membership = { role: 'member' }
    const body = await (await estimateHandler(post(hunt, 'ok'))).text()
    expect(body).not.toContain('segreto-di-prova')
    expect(body).not.toContain('service')
    delete process.env.DEMAND_HUNTER_SERVICE_SECRET
  })
})
