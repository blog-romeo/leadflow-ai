// @vitest-environment node
import { describe, expect, it, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { HttpError } from '../../http'
import { readDemandHunterConfig } from '../config'
import { canonical, createServiceClient, signRequest } from '../gateway'
import { DEMAND_AGENTS, assertTool, demandHunterAgent, intentAnalysisAgent, leadQualificationAgent, orchestratorBudgetCheck } from '../agents'
import { isForbiddenTool } from '../../agents/catalog'
import { estimate, jobView, learning, setFeedback, start, stop, transferToCrm, leadWritesFrom } from '../services'
import { actionKey, sha256Hex } from '../tokens'
import { estimateSchema, startSchema } from '../validation'
import { BUYER, fakeService, memoryStore, reading, snapshot } from './memory'

/** Demand Hunter (gateway Netlify): solo dati simulati, nessuna rete, nessuna spesa. */
const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '33333333-3333-4333-8333-333333333333'
const USER = '22222222-2222-4222-8222-222222222222'
const OTHER_USER = '44444444-4444-4444-8444-444444444444'
const A = { orgId: ORG_A, userId: USER }
const huntIn = (budget = 5) => ({ organization_id: ORG_A, action: 'hunt' as const, goal: 'clienti' as const, seed: 'Laravel', budget })

describe('gateway: firma HMAC compatibile con il servizio Python', () => {
  it('stessa firma calcolata da services/demand-hunter/app/security.py', () => {
    const body = '{"seed":"Laravel","budget":5}'
    expect(signRequest('k'.repeat(40), '1700000000', 'nonce_abcdefghijklmnop', 'POST', '/v1/hunts', ORG_A, USER, body)).toBe('7bd6c3dd792a29f8233eebe13bdbb30bc2c3fd9f30c951c6c05425c330ce9671')
    expect(signRequest('k'.repeat(40), '1700000000', 'nonce_abcdefghijklmnop', 'GET', '/v1/status', ORG_A, USER, '')).toBe('bb3b1d0dbf35fd5611fca16727373f4100e2674a07c3fb720ad50940e2e0445c')
  })
  it('organizzazione e utente firmati vengono SOLO dal contesto autorizzato', async () => {
    const seen: Headers[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const client = createServiceClient({ url: 'https://dh.example.test', secret: 's'.repeat(40) }, fetchImpl, () => 1_700_000_000_000)
    await client.call(A, 'POST', '/v1/hunts/plan', { seed: 'Laravel', budget: 5, organization_id: ORG_B })
    const h = seen[0]
    expect(h.get('x-dh-org')).toBe(ORG_A)
    expect(h.get('x-dh-user')).toBe(USER)
    const expected = createHmac('sha256', 's'.repeat(40))
      .update(canonical(h.get('x-dh-timestamp')!, h.get('x-dh-nonce')!, 'POST', '/v1/hunts/plan', ORG_A, USER, JSON.stringify({ seed: 'Laravel', budget: 5, organization_id: ORG_B })))
      .digest('hex')
    expect(h.get('x-dh-signature')).toBe(expected)
    expect(h.get('authorization')).toBeNull()
  })
  it('errori del servizio → codici stabili, nessun dettaglio interno', async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    const mk = (status: number, body: unknown) => createServiceClient({ url: 'https://dh.example.test', secret: 's'.repeat(40) }, reply(status, body))
    await expect(mk(401, { error: 'unauthorized' }).call(A, 'GET', '/v1/status')).rejects.toMatchObject({ status: 503, code: 'demand_hunter_service_unavailable' })
    await expect(mk(429, { detail: 'too_many_running_hunts' }).call(A, 'POST', '/v1/hunts', {})).rejects.toMatchObject({ status: 429 })
    await expect(mk(500, { detail: 'Traceback /app/secret.py' }).call(A, 'GET', '/v1/status')).rejects.toMatchObject({ status: 502, code: 'demand_hunter_service_error', details: undefined })
    const down = createServiceClient({ url: 'https://dh.example.test', secret: 's'.repeat(40) }, (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)
    await expect(down.call(A, 'GET', '/v1/status')).rejects.toMatchObject({ status: 503, code: 'demand_hunter_service_unreachable' })
  })
  it('configurazione: HTTPS obbligatorio, segreto ≥ 32 caratteri, nessun valore restituito', () => {
    expect(readDemandHunterConfig({}).config).toBeNull()
    expect(readDemandHunterConfig({ DEMAND_HUNTER_SERVICE_URL: 'http://dh.example.test', DEMAND_HUNTER_SERVICE_SECRET: 's'.repeat(40) }).invalid).toContain('DEMAND_HUNTER_SERVICE_URL')
    expect(readDemandHunterConfig({ DEMAND_HUNTER_SERVICE_URL: 'https://dh.example.test', DEMAND_HUNTER_SERVICE_SECRET: 'short' }).invalid).toContain('DEMAND_HUNTER_SERVICE_SECRET')
    expect(readDemandHunterConfig({ DEMAND_HUNTER_SERVICE_URL: 'https://dh.example.test/', DEMAND_HUNTER_SERVICE_SECRET: 's'.repeat(40) }).config?.url).toBe('https://dh.example.test')
    expect(readDemandHunterConfig({ DEMAND_HUNTER_SERVICE_URL: 'https://dh.example.test', DEMAND_HUNTER_SERVICE_SECRET: 's'.repeat(40), DEMAND_HUNTER_ENABLED: 'false' }).config).toBeNull()
    expect(JSON.stringify(readDemandHunterConfig({ DEMAND_HUNTER_SERVICE_URL: 'https://dh.example.test', DEMAND_HUNTER_SERVICE_SECRET: 'z'.repeat(40) }).missing)).not.toContain('zzzz')
  })
})

describe('budget: nessuna ricerca a pagamento senza conferma esplicita', () => {
  let m: ReturnType<typeof memoryStore>
  let f: ReturnType<typeof fakeService>
  beforeEach(() => {
    m = memoryStore()
    f = fakeService()
  })
  const deps = () => ({ store: m.store, service: f.svc })

  it('la stima è gratuita e restituisce un token monouso; nel database solo il suo hash', async () => {
    const e = await estimate(deps(), A, huntIn())
    expect(e.allowed).toBe(true)
    expect(e.confirm_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(m.confirmations[0].tokenHash).toBe(sha256Hex(e.confirm_token!))
    expect(JSON.stringify(m.confirmations)).not.toContain(e.confirm_token)
    expect(f.calls.some((c) => c.path === '/v1/hunts')).toBe(false)
  })
  it('senza token valido non parte nulla', async () => {
    await expect(start(deps(), A, { ...huntIn(), confirm_token: 'x'.repeat(43) })).rejects.toMatchObject({ status: 409, code: 'confirmation_invalid' })
    expect(f.calls.some((c) => c.path === '/v1/hunts')).toBe(false)
    expect(m.jobs).toHaveLength(0)
  })
  it('il token vale una volta sola (richieste duplicate rifiutate)', async () => {
    const e = await estimate(deps(), A, huntIn())
    const ok = await start(deps(), A, { ...huntIn(), confirm_token: e.confirm_token! })
    expect(ok.job_id).toBeTruthy()
    await expect(start(deps(), A, { ...huntIn(), confirm_token: e.confirm_token! })).rejects.toMatchObject({ code: 'confirmation_invalid' })
    expect(f.calls.filter((c) => c.path === '/v1/hunts')).toHaveLength(1)
    // la chiave di idempotenza inviata al servizio è l'id del job
    expect((f.calls.find((c) => c.path === '/v1/hunts')!.body as { idempotency_key: string }).idempotency_key).toBe(ok.job_id)
  })
  it('il token è legato all\'utente, al seme e al budget', async () => {
    const e = await estimate(deps(), A, huntIn(5))
    await expect(start(deps(), { orgId: ORG_A, userId: OTHER_USER }, { ...huntIn(5), confirm_token: e.confirm_token! })).rejects.toMatchObject({ code: 'confirmation_invalid' })
    await expect(start(deps(), A, { ...huntIn(20), confirm_token: e.confirm_token! })).rejects.toMatchObject({ code: 'confirmation_invalid' })
    await expect(start(deps(), A, { ...huntIn(5), seed: 'React', confirm_token: e.confirm_token! })).rejects.toMatchObject({ code: 'confirmation_invalid' })
    expect(actionKey('hunt', 'clienti', '  LARAVEL ', 5)).toBe(actionKey('hunt', 'clienti', 'laravel', 5))
  })
  it('limiti dell\'organizzazione: nessun token oltre il massimo per caccia o il limite mensile (live)', async () => {
    m = memoryStore({ limits: { [ORG_A]: { monthly: 10, perHunt: 8 } } })
    expect(await estimate(deps(), A, huntIn(9))).toMatchObject({ allowed: false, reason: 'budget_per_hunt' })
    f = fakeService({ mode: 'live' })
    const e1 = await estimate(deps(), A, huntIn(8))
    await start(deps(), A, { ...huntIn(8), confirm_token: e1.confirm_token! })
    expect(await estimate(deps(), A, huntIn(5))).toMatchObject({ allowed: false, reason: 'monthly_limit' })
    expect(m.confirmations).toHaveLength(1)
  })
  it('limite raggiunto tra stima e avvio: 402 e nessuna caccia', async () => {
    m = memoryStore({ limits: { [ORG_A]: { monthly: 10, perHunt: 8 } } })
    f = fakeService({ mode: 'live' })
    const e1 = await estimate(deps(), A, huntIn(6))
    const e2 = await estimate(deps(), A, huntIn(6))
    await start(deps(), A, { ...huntIn(6), confirm_token: e1.confirm_token! })
    await expect(start(deps(), A, { ...huntIn(6), confirm_token: e2.confirm_token! })).rejects.toMatchObject({ status: 402, code: 'demand_hunter_limit_reached' })
    expect(f.calls.filter((c) => c.path === '/v1/hunts')).toHaveLength(1)
  })
  it('alla fine del job le chiamate non usate tornano disponibili (una sola volta)', async () => {
    f = fakeService({ mode: 'live' })
    const e = await estimate(deps(), A, huntIn(5))
    const s = await start(deps(), A, { ...huntIn(5), confirm_token: e.confirm_token! })
    const view = await jobView(deps(), A, s.job_id)
    expect(view.job.status).toBe('completed')
    expect((await m.store.usageSummary(ORG_A)).used).toBe(4) // 3 ricerche + 1 suggerimento
    await jobView(deps(), A, s.job_id)
    expect((await m.store.usageSummary(ORG_A)).used).toBe(4)
  })
  it('senza fornitore di ricerca configurato: nessun token', async () => {
    f = fakeService({ providerConfigured: false })
    expect(await estimate(deps(), A, huntIn())).toMatchObject({ allowed: false, reason: 'search_provider_not_configured' })
  })
  it('servizio non configurato → 503 esplicito', async () => {
    await expect(estimate({ store: m.store, service: null }, A, huntIn())).rejects.toMatchObject({ status: 503, code: 'demand_hunter_not_configured' })
  })
  it('validazione: budget e testo controllati prima di tutto', () => {
    expect(estimateSchema.safeParse({ ...huntIn(), budget: 501 }).success).toBe(false)
    expect(estimateSchema.safeParse({ ...huntIn(), seed: 'a"b' }).success).toBe(false)
    expect(estimateSchema.safeParse({ ...huntIn(), organization_id: 'x' }).success).toBe(false)
    expect(startSchema.safeParse({ ...huntIn() }).success).toBe(false)
  })
  it('espansione di un\'area: stessa conferma, concetti salvati, spesa chiusa', async () => {
    const input = { organization_id: ORG_A, action: 'expand' as const, goal: 'clienti' as const, label: 'Cybersecurity' }
    const e = await estimate(deps(), A, input)
    expect(e.paid_calls).toBe(2)
    const r = await start(deps(), A, { ...input, confirm_token: e.confirm_token! })
    expect(r.added).toHaveLength(1)
    expect(m.concepts[0]).toMatchObject({ org: ORG_A, label: 'siem per pmi', parentNorm: 'cybersecurity' })
  })
})

describe('isolamento delle organizzazioni', () => {
  it('un job, una sessione e i lead di A non sono visibili da B', async () => {
    const m = memoryStore()
    const f = fakeService()
    const deps = { store: m.store, service: f.svc }
    const e = await estimate(deps, A, huntIn())
    const s = await start(deps, A, { ...huntIn(), confirm_token: e.confirm_token! })
    await jobView(deps, A, s.job_id)
    const B = { orgId: ORG_B, userId: OTHER_USER }
    await expect(jobView(deps, B, s.job_id)).rejects.toMatchObject({ status: 404 })
    await expect(stop(deps, B, s.job_id)).rejects.toMatchObject({ status: 404 })
    const leadId = m.leads[0].id
    await expect(setFeedback(deps, B, leadId, 'giusto')).rejects.toMatchObject({ status: 404 })
    expect((await transferToCrm(deps, B, [leadId])).results[0].outcome).toBe('not_found')
    // ogni chiamata al servizio porta l'organizzazione del contesto
    expect(f.calls.every((c) => c.ctx.orgId === ORG_A || c.ctx.orgId === ORG_B)).toBe(true)
    expect(f.calls.filter((c) => c.ctx.orgId === ORG_B).every((c) => !c.path.includes('/v1/hunts/svc'))).toBe(true)
  })
  it('il token di A non vale per B', async () => {
    const m = memoryStore()
    const f = fakeService()
    const deps = { store: m.store, service: f.svc }
    const e = await estimate(deps, A, huntIn())
    await expect(start(deps, { orgId: ORG_B, userId: USER }, { ...huntIn(), organization_id: ORG_B, confirm_token: e.confirm_token! })).rejects.toMatchObject({ code: 'confirmation_invalid' })
  })
})

describe('classificazione (Intent Analysis e Lead Qualification Agent)', () => {
  it('ogni lead conserva le prove testuali; una lettura non valida è scartata', () => {
    const out = intentAnalysisAgent(snapshot().lead_list).output
    expect(out).toHaveLength(2)
    expect(out[0].reading.evidence.map((e) => e.signal)).toEqual(['ask', 'budget'])
  })
  it('venditori e giudizi "sbagliato" non sono qualificati; i migliori prima', () => {
    const q = leadQualificationAgent('clienti', [
      { url: 'a', score: 60, reading: reading({ author_role: 'seller' }) as never, verdict: null },
      { url: 'b', score: 96, reading: reading() as never, verdict: 'sbagliato' },
      { url: 'c', score: 80, reading: reading() as never, verdict: 'giusto' },
    ]).output
    expect(q.map((x) => [x.url, x.qualified])).toEqual([['c', true], ['b', false], ['a', false]])
    expect(q.find((x) => x.url === 'a')!.reasons).toContain('not_buyer')
    expect(q.find((x) => x.url === 'c')).toMatchObject({ priority: 'high', reasons: expect.arrayContaining(['confirmed', 'budget_declared']) })
  })
  it('uno snapshot oltre il budget o malformato viene rifiutato', () => {
    expect(() => demandHunterAgent(snapshot({ spent: { searches: 9, autocomplete: 0 } }))).toThrow(HttpError)
    expect(() => demandHunterAgent({ status: 'finita' })).toThrow(HttpError)
  })
  it('agenti: strumenti in allowlist, nessuno strumento vietato dal catalogo globale', () => {
    for (const a of Object.values(DEMAND_AGENTS)) for (const t of a.tools) expect(isForbiddenTool(t), t).toBe(false)
    expect(() => assertTool('intent_analysis', 'service.hunt.start')).toThrow(HttpError)
    expect(() => assertTool('learning', 'crm.save_leads')).toThrow(HttpError)
    expect(DEMAND_AGENTS.lead_qualification.handsOffTo).toBe('scoring')
    expect(orchestratorBudgetCheck({ enabled: true, monthly_paid_calls: 10, max_budget_per_hunt: 50, used: 10, remaining: 0 }, 5, 'simulated')).toEqual({ allowed: true })
    expect(orchestratorBudgetCheck({ enabled: true, monthly_paid_calls: 10, max_budget_per_hunt: 50, used: 10, remaining: 0 }, 5, 'live')).toMatchObject({ allowed: false })
  })
})

describe('deduplicazione', () => {
  it('lo stesso testo sotto un altro URL è un solo lead; una seconda sincronizzazione non duplica', async () => {
    const m = memoryStore()
    const f = fakeService()
    const deps = { store: m.store, service: f.svc }
    const e = await estimate(deps, A, huntIn())
    const s = await start(deps, A, { ...huntIn(), confirm_token: e.confirm_token! })
    const v = await jobView(deps, A, s.job_id)
    expect(v.leads).toHaveLength(2)
    expect(m.leads.every((l) => l.simulated)).toBe(true)
    // seconda caccia con gli stessi post: nessun nuovo lead
    const e2 = await estimate(deps, A, huntIn())
    const s2 = await start(deps, A, { ...huntIn(), confirm_token: e2.confirm_token! })
    await jobView(deps, A, s2.job_id)
    expect(m.leads).toHaveLength(2)
  })
  it('hash: URL esatto, testo normalizzato (spazi e maiuscole)', () => {
    const rows = leadWritesFrom('clienti', 's', snapshot(), 'live')
    expect(rows[0].textHash).toBe(rows[1].textHash)
    expect(rows[0].urlHash).not.toBe(rows[1].urlHash)
    expect(rows[0].simulated).toBe(false)
  })
  it('CRM: deduplicato, mai i lead simulati, mai quelli giudicati sbagliati, nessun messaggio inviato', async () => {
    const m = memoryStore()
    const live = fakeService({ mode: 'live' })
    const deps = { store: m.store, service: live.svc }
    const e = await estimate(deps, A, huntIn())
    const s = await start(deps, A, { ...huntIn(), confirm_token: e.confirm_token! })
    const v = await jobView(deps, A, s.job_id)
    const [first, second] = v.leads
    await setFeedback(deps, A, second.id, 'sbagliato')
    const r1 = await transferToCrm(deps, A, [first.id, second.id])
    expect(r1.results.map((r) => r.outcome)).toEqual(['saved', 'marked_wrong'])
    expect(m.crm[0]).toMatchObject({ dedupKey: `dh:${sha256Hex(BUYER.toLowerCase())}`, priority: 'high' })
    expect(m.crm[0].notes).toContain('nessun messaggio è stato inviato')
    expect(m.crm[0].notes).toContain('https://www.facebook.com/groups/esempio-simulato/posts/1-laravel')
    const r2 = await transferToCrm(deps, A, [first.id])
    expect(r2.results[0].outcome).toBe('already_transferred')
    expect(m.crm).toHaveLength(1)
    // lead simulati: rifiutati
    m.leads.push({ ...m.leads[0], id: '00000000-0000-4000-8000-0000000009ff', urlHash: 'z', textHash: 'zz', status: 'new', crmLeadId: null, simulated: true })
    expect((await transferToCrm(deps, A, ['00000000-0000-4000-8000-0000000009ff'])).results[0].outcome).toBe('simulated')
    // stesso testo già nel CRM da un altro lead: duplicato
    m.leads.push({ ...m.leads[0], id: '00000000-0000-4000-8000-0000000009fe', urlHash: 'other', status: 'new', crmLeadId: null, simulated: false })
    expect((await transferToCrm(deps, A, ['00000000-0000-4000-8000-0000000009fe'])).results[0].outcome).toBe('duplicate')
  })
  it('CRM: quota lead del piano rispettata', async () => {
    const m = memoryStore()
    const f = fakeService({ mode: 'live' })
    const billing = { countNewLeads: async (_o: string, _u: string | null, refs: string[]) => ({ over_quota_refs: refs }), recordProviderCall: async () => {} }
    const deps = { store: m.store, service: f.svc, billing }
    const e = await estimate(deps, A, huntIn())
    const s = await start(deps, A, { ...huntIn(), confirm_token: e.confirm_token! })
    const v = await jobView(deps, A, s.job_id)
    expect((await transferToCrm(deps, A, [v.leads[0].id])).results[0].outcome).toBe('over_quota')
    expect(m.crm).toHaveLength(0)
  })
  it('chiamate SerpApi reali registrate nel Control Center una volta sola; le simulate no', async () => {
    const recorded: string[] = []
    const billing = { countNewLeads: async () => ({ over_quota_refs: [] }), recordProviderCall: async (_o: string, _u: string | null, p: string, k: string) => { recorded.push(`${p}:${k}`) } }
    for (const mode of ['simulated', 'live'] as const) {
      const m = memoryStore()
      const f = fakeService({ mode })
      const deps = { store: m.store, service: f.svc, billing }
      const e = await estimate(deps, A, huntIn())
      const s = await start(deps, A, { ...huntIn(), confirm_token: e.confirm_token! })
      await jobView(deps, A, s.job_id)
      await jobView(deps, A, s.job_id)
    }
    expect(recorded).toHaveLength(4)
    expect(new Set(recorded).size).toBe(4)
    expect(recorded.every((r) => r.startsWith('serpapi:dh:'))).toBe(true)
  })
})

describe('feedback Giusto/Sbagliato', () => {
  it('salvato nel database e inoltrato all\'apprendimento del servizio', async () => {
    const m = memoryStore()
    const f = fakeService()
    const deps = { store: m.store, service: f.svc }
    const e = await estimate(deps, A, huntIn())
    const s = await start(deps, A, { ...huntIn(), confirm_token: e.confirm_token! })
    const v = await jobView(deps, A, s.job_id)
    const r = await setFeedback(deps, A, v.leads[0].id, 'giusto')
    expect(r).toMatchObject({ verdict: 'giusto', learning_synced: true })
    expect(f.calls.at(-1)).toMatchObject({ path: '/v1/learning/clienti/feedback', body: { url: v.leads[0].url, verdict: 'giusto' } })
    expect((await jobView(deps, A, s.job_id)).leads.find((l) => l.id === v.leads[0].id)?.verdict).toBe('giusto')
    await setFeedback(deps, A, v.leads[0].id, null)
    expect(m.feedback.size).toBe(0)
  })
  it('servizio irraggiungibile: il giudizio resta salvato, e lo si dice', async () => {
    const m = memoryStore()
    const f = fakeService()
    const deps = { store: m.store, service: f.svc }
    const e = await estimate(deps, A, huntIn())
    const s = await start(deps, A, { ...huntIn(), confirm_token: e.confirm_token! })
    const v = await jobView(deps, A, s.job_id)
    const down = fakeService({ down: true })
    const r = await setFeedback({ store: m.store, service: down.svc }, A, v.leads[0].id, 'sbagliato')
    expect(r).toMatchObject({ verdict: 'sbagliato', learning_synced: false })
    expect(m.feedback.get(v.leads[0].id)?.verdict).toBe('sbagliato')
  })
  it('statistiche di apprendimento: dal servizio, poi dalla copia salvata se il servizio è giù', async () => {
    const m = memoryStore()
    const f = fakeService()
    expect((await learning({ store: m.store, service: f.svc }, A, 'clienti')).source).toBe('service')
    const cached = await learning({ store: m.store, service: fakeService({ down: true }).svc }, A, 'clienti')
    expect(cached.source).toBe('cache')
    expect(cached.verbs[0]).toMatchObject({ key: 'cerco', leads: 1 })
    expect((await learning({ store: m.store, service: null }, { orgId: ORG_B, userId: USER }, 'clienti')).verbs).toHaveLength(0)
  })
  it('rate limit: 429 con retry_after', async () => {
    const m = memoryStore()
    m.rate.allowed = false
    await expect(estimate({ store: m.store, service: fakeService().svc }, A, huntIn())).rejects.toMatchObject({ status: 429, code: 'rate_limited' })
  })
})

describe('avvio non confermato (timeout verso il servizio)', () => {
  it('il job resta in coda e la sincronizzazione recupera la stessa caccia, senza avviarne una seconda', async () => {
    const m = memoryStore()
    const f = fakeService()
    let fail = true
    const flaky = {
      async call<T>(ctx: { orgId: string; userId: string }, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
        if (path === '/v1/hunts' && fail) {
          fail = false
          await f.svc.call(ctx, method, path, body) // il servizio la avvia comunque…
          throw new HttpError(503, 'demand_hunter_service_unreachable') // …ma la risposta si perde
        }
        return f.svc.call<T>(ctx, method, path, body)
      },
    }
    const deps = { store: m.store, service: flaky }
    const e = await estimate(deps, A, huntIn())
    const s = await start(deps, A, { ...huntIn(), confirm_token: e.confirm_token! })
    expect(s).toMatchObject({ pending: true })
    expect(m.jobs[0]).toMatchObject({ status: 'queued', errorCode: 'start_unconfirmed', serviceJobId: null })
    const v = await jobView(deps, A, s.job_id)
    expect(v.job.status).toBe('completed')
    expect(f.started.size).toBe(1) // una sola caccia nel servizio
    expect(v.leads.length).toBeGreaterThan(0)
  })
})
