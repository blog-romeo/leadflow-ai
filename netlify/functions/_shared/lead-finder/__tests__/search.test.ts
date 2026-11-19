// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMemoryStore } from './memoryStore'
import { GOOGLE_ENV, ORG_A, ORG_B, OSM_ENV, USER_A, USER_B, googlePage1, googlePage2, hotelProfile, jsonResponse, mockFetch, overpassBody, searchInput } from './fixtures'
import { createRegistry } from '../providers/registry'
import { buildOverpassQuery } from '../providers/osmOverpass'
import { runSearch } from '../services'
import { HttpError } from '../../http'

function osmRegistry(handler = () => jsonResponse(overpassBody)) {
  const f = mockFetch(handler)
  return { registry: createRegistry({ ...OSM_ENV, ...GOOGLE_ENV }, f.fn), calls: f.calls }
}

async function expectHttp(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(HttpError)
  expect((err as HttpError).status).toBe(status)
  expect((err as HttpError).code).toBe(code)
  return err as HttpError
}

describe('1. Ricerca con provider configurato', () => {
  it('OpenStreetMap: interroga l’endpoint configurato, normalizza, deduplica e salva i candidati', async () => {
    const { store, state } = createMemoryStore({ profiles: { [ORG_A]: hotelProfile } })
    const { registry, calls } = osmRegistry()
    const input = searchInput()
    const res = await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, input)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(OSM_ENV.OVERPASS_API_URL)
    const body = new URLSearchParams(String(calls[0]!.init?.body)).get('data')
    expect(body).toContain('["tourism"="hotel"]')
    expect(body).toContain('[!"brand"]') // "indipendenti" esclude le catene

    // 4 elementi: uno senza nome scartato, uno duplicato per dominio nel batch.
    expect(res.counts).toMatchObject({ found: 2, new: 2, duplicates_in_batch: 1 })
    expect(res.ephemeral).toBeUndefined()
    const aurora = state.candidates.find((c) => c.externalId === 'node/101')!
    expect(aurora).toMatchObject({ companyName: 'Hotel Aurora', city: 'Roma', country: 'IT', website: 'https://www.hotelaurora.example', phone: '+39 06 1234567', canSaveToCrm: true })
    expect(aurora.sourceUrl).toBe('https://www.openstreetmap.org/node/101')
    expect(aurora.attribution).toContain('OpenStreetMap')
    expect(aurora.score).toBeGreaterThan(0)
    expect(aurora.scoreBasis).toBe('rules')
    expect(state.searches.get(input.search_id)).toMatchObject({ status: 'completed', stage: 'done', new_count: 2 })
  })

  it('query Overpass: filtri sito, area nel paese, limite risultati ed escape dell’input', () => {
    const q = buildOverpassQuery({ sector: 'hotel', location: 'Roma"];out;', country: 'it', keywords: [], maxResults: 500, websiteFilter: 'without' }, 8)
    expect(q).toContain('area["ISO3166-1"="IT"]["admin_level"="2"]->.country;')
    expect(q).toContain('[!"website"][!"contact:website"]')
    expect(q).toContain('out center tags 200;')
    expect(q).not.toContain('"];out;"') // virgolette in input sempre escape
    expect(q).toContain('\\"')
  })

  it('Google Places: risultati solo in sessione, nessun contenuto memorizzato, pagine multiple e filtro sito', async () => {
    const { store, state } = createMemoryStore()
    const f = mockFetch((_url, init) => jsonResponse(JSON.parse(String(init?.body)).pageToken ? googlePage2 : googlePage1))
    const registry = createRegistry(GOOGLE_ENV, f.fn)
    const res = await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput({ provider: 'google_places', website_filter: 'with' }))

    expect(f.calls).toHaveLength(2)
    expect((f.calls[0]!.init?.headers as Record<string, string>)['X-Goog-FieldMask']).toContain('places.websiteUri')
    expect(res.counts.found).toBe(1) // "Hotel Senza Sito" filtrato
    expect(res.ephemeral?.[0]?.company.companyName).toBe('Hotel Colosseo Boutique')
    expect(res.license).toMatchObject({ canStoreContent: false, canExport: false, canSaveToCrm: false })
    const stored = state.candidates[0]!
    expect(stored.externalId).toBe('ChIJ_one') // solo il place_id
    expect([stored.companyName, stored.website, stored.phone, stored.city, stored.score]).toEqual([null, null, null, null, null])
  })
})

describe('2. Provider senza credenziali', () => {
  it('risponde "configurazione richiesta" con le variabili mancanti e non chiama nessuna API', async () => {
    const { store, state } = createMemoryStore()
    const f = mockFetch(() => jsonResponse({}))
    const registry = createRegistry({}, f.fn)
    const err = await expectHttp(runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput()), 409, 'provider_not_configured')
    expect(err.details?.missing).toEqual(['OVERPASS_API_URL', 'OVERPASS_CONTACT'])
    await expectHttp(runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput({ provider: 'google_places' })), 409, 'provider_not_configured')
    expect(f.calls).toHaveLength(0)
    expect(state.usage.filter((u) => u.event === 'lead_search')).toHaveLength(0) // nessun credito consumato
  })

  it('un endpoint Overpass non HTTPS non è considerato configurato', () => {
    const r = createRegistry({ OVERPASS_API_URL: 'http://overpass.local', OVERPASS_CONTACT: 'x' })
    expect(r.osm_overpass.missingConfig()).toContain('OVERPASS_API_URL')
  })
})

describe('3. Isolamento dati tra organizzazioni', () => {
  it('stesso risultato in due organizzazioni: candidati separati e nessun accesso incrociato', async () => {
    const { store, state } = createMemoryStore()
    const { registry } = osmRegistry()
    await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    await runSearch({ store, registry }, { orgId: ORG_B, userId: USER_B }, searchInput({ organization_id: ORG_B }))
    const a = state.candidates.filter((c) => c.organizationId === ORG_A)
    const b = state.candidates.filter((c) => c.organizationId === ORG_B)
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
    expect(await store.getCandidates(ORG_B, a.map((c) => c.id))).toHaveLength(0)
  })
})

describe('4. Prevenzione duplicati', () => {
  it('ripetere la stessa ricerca non crea doppioni né consuma crediti risultato', async () => {
    const { store, state } = createMemoryStore()
    const { registry } = osmRegistry()
    await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    const second = await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    expect(second.counts).toMatchObject({ found: 2, new: 0, already_known: 2 })
    expect(state.candidates).toHaveLength(2)
    expect(state.usage.filter((u) => u.event === 'lead_result').reduce((a, u) => a + u.qty, 0)).toBe(2)
  })

  it('un’azienda già nel CRM viene riconosciuta anche se arriva da un’altra fonte', async () => {
    const { store, state } = createMemoryStore()
    state.leads.push({ id: 'l1', org: ORG_A, provider: 'csv_import', externalId: 'x', dedupKey: 'hotelaurora.example' } as never)
    const { registry } = osmRegistry()
    const res = await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    expect(res.counts.in_crm).toBe(1)
  })
})

describe('7. Gestione errori API del provider', () => {
  const cases: [string, () => Response | Promise<Response>, number, string][] = [
    ['429 Overpass', () => new Response('', { status: 429 }), 429, 'provider_rate_limited'],
    ['403 credenziali', () => new Response('', { status: 403 }), 502, 'provider_auth_failed'],
    ['500 servizio', () => new Response('', { status: 500 }), 503, 'provider_unavailable'],
    ['JSON non valido', () => new Response('<html>', { status: 200 }), 502, 'provider_bad_response'],
    ['remark runtime error', () => jsonResponse({ elements: [], remark: 'runtime error: Query timed out' }), 504, 'provider_timeout'],
  ]
  for (const [name, handler, status, code] of cases) {
    it(`${name} → ${code}, ricerca marcata come fallita`, async () => {
      const { store, state } = createMemoryStore()
      const { registry } = osmRegistry(handler as () => Response)
      const input = searchInput()
      await expectHttp(runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, input), status, code)
      expect(state.searches.get(input.search_id)).toMatchObject({ status: 'failed', error_code: code })
      expect(state.candidates).toHaveLength(0)
    })
  }

  it('timeout di rete → provider_timeout', async () => {
    const { store } = createMemoryStore()
    const slow = mockFetch((_u, init) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))))
    const registry = createRegistry(OSM_ENV, slow.fn)
    const adapter = registry.osm_overpass
    const err = await adapter.search({ sector: 'hotel', location: 'Roma', country: 'IT', keywords: [], maxResults: 5, websiteFilter: 'any' }, { timeoutMs: 50 }).catch((e) => e)
    expect(err.code).toBe('provider_timeout')
  })
})

describe('8. Controllo dei limiti', () => {
  it('quota mensile di ricerche esaurita → 429 senza chiamare il provider', async () => {
    const { store } = createMemoryStore({ quotas: { [ORG_A]: { monthly_searches: 1, monthly_results: 1000, monthly_ai_analyses: 10, requests_per_minute: 20 } } })
    const { registry, calls } = osmRegistry()
    await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    await expectHttp(runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput()), 429, 'quota_searches_exceeded')
    expect(calls).toHaveLength(1)
  })

  it('crediti risultato residui limitano il numero massimo richiesto', async () => {
    const { store } = createMemoryStore({ quotas: { [ORG_A]: { monthly_searches: 10, monthly_results: 3, monthly_ai_analyses: 10, requests_per_minute: 20 } } })
    const { registry, calls } = osmRegistry()
    await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput({ max_results: 50 }))
    const body = new URLSearchParams(String(calls[0]!.init?.body)).get('data')
    expect(body).toContain('out center tags 3;')
  })

  it('crediti risultato esauriti → 429', async () => {
    const { store } = createMemoryStore({ quotas: { [ORG_A]: { monthly_searches: 10, monthly_results: 2, monthly_ai_analyses: 10, requests_per_minute: 20 } } })
    const { registry } = osmRegistry()
    await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    await expectHttp(runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput()), 429, 'quota_results_exceeded')
  })

  it('rate limit per utente → 429 con retry_after', async () => {
    const { store } = createMemoryStore({ quotas: { [ORG_A]: { monthly_searches: 100, monthly_results: 1000, monthly_ai_analyses: 10, requests_per_minute: 2 } } })
    const { registry } = osmRegistry()
    await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    await runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    const err = await expectHttp(runSearch({ store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput()), 429, 'rate_limited')
    expect(err.details?.retry_after).toBeGreaterThan(0)
  })
})
