// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMemoryStore } from './memoryStore'
import { ORG_A, OSM_ENV, USER_A, hotelProfile, jsonResponse, mockFetch, overpassBody, searchInput } from './fixtures'
import { createRegistry } from '../providers/registry'
import { runSearch } from '../services'
import { analyzeCompany, readWebsite, verifyOutput, type WebsiteContent } from '../analysis/analyzer'
import { requestAnalysis, runAnalysisJob } from '../analysisService'
import { callStructured } from '../analysis/openai'
import { SsrfError } from '../analysis/ssrf'
import type { ModelOutput } from '../analysis/schema'

const AI_ENV = { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'test-model', LEADFLOW_INTERNAL_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv
const SITE: WebsiteContent = {
  url: 'https://hotelaurora.example', status: 'analyzed', fetchedAt: '', title: 'Hotel Aurora Roma', description: null,
  text: 'Hotel a conduzione familiare nel centro di Roma. Per prenotare scrivete una email oppure telefonate. Cerchiamo receptionist per la stagione estiva.',
}
const company = { companyName: 'Hotel Aurora', sector: 'hotel', categoryTags: [], address: null, city: 'Roma', region: null, country: 'IT', website: 'https://hotelaurora.example', phone: null }

function modelOutput(over: Partial<ModelOutput> = {}): ModelOutput {
  return {
    sector: { value: 'Ospitalità', basis: 'verified', evidence: 'Hotel a conduzione familiare' },
    activity_description: { value: 'Hotel familiare a Roma', basis: 'verified', evidence: 'citazione inesistente nel testo' },
    verified_facts: [
      { statement: 'Gestione familiare', evidence: 'a conduzione familiare nel centro di Roma' },
      { statement: 'Ha 120 camere', evidence: 'dispone di 120 camere' },
    ],
    hypotheses: [{ statement: 'Struttura piccola', rationale: 'conduzione familiare' }],
    digital_needs: [{ need: 'Booking engine', rationale: 'prenotazioni via email', evidence: 'Per prenotare scrivete una email' }],
    opportunities: [{ opportunity: 'Proporre prenotazione diretta', rationale: 'riduce commissioni' }],
    missing_information: ['Numero di camere'],
    fit: { sector_rating: 14, sector_reason: 'Hotel', icp_rating: 8, icp_reason: 'Indipendente' },
    signals: [
      { signal: 'Assunzioni stagionali', evidence: 'Cerchiamo receptionist per la stagione estiva' },
      { signal: 'Nuova sede', evidence: 'apriamo una nuova sede a Milano' },
    ],
    qualification_reason: 'Buona corrispondenza',
    ...over,
  }
}

function openAiResponse(json: unknown, extra: Record<string, unknown> = {}) {
  return jsonResponse({ status: 'completed', model: 'test-model', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }], usage: { input_tokens: 900, output_tokens: 300 }, ...extra })
}

describe('AI Business Analyzer: fatti, ipotesi e informazioni mancanti', () => {
  it('declassa a ipotesi ogni citazione non presente nel sito; esigenze sempre ipotesi', () => {
    const r = verifyOutput(modelOutput(), SITE, company, 'OpenStreetMap', { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } })
    const site = r.verified_facts.filter((f) => f.source === 'website')
    expect(site.map((f) => f.statement)).toEqual(['Gestione familiare'])
    expect(r.hypotheses.some((h) => h.statement === 'Ha 120 camere' && /non trovata/.test(h.rationale))).toBe(true)
    expect(r.verified_facts.filter((f) => f.source === 'provider').map((f) => f.evidence)).toContain('Hotel Aurora')
    expect(r.sector.basis).toBe('verified')
    expect(r.activity_description.basis).toBe('hypothesis')
    expect(r.digital_needs.every((d) => d.basis === 'hypothesis')).toBe(true)
    expect(r.signals.map((s) => s.verified)).toEqual([true, false])
    expect(r.fit.sector_rating).toBe(10) // valori fuori scala limitati a 0–10
  })

  it('sito non disponibile: lo dichiara tra le informazioni mancanti', () => {
    const r = verifyOutput(modelOutput({ verified_facts: [], signals: [] }), { ...SITE, status: 'no_website', text: '', title: null }, company, 'OSM', { model: 'm', usage: { input_tokens: 0, output_tokens: 0 } })
    expect(r.missing_information.at(-1)).toContain('no_website')
    expect(r.sector.basis).toBe('hypothesis')
  })

  it('robots.txt che vieta l’accesso: il sito non viene letto', async () => {
    const calls: string[] = []
    const fetchText = (async (url: string) => {
      calls.push(url)
      return { url, status: 200, contentType: 'text/plain', body: 'User-agent: *\nDisallow: /' }
    }) as never
    const site = await readWebsite('https://hotelaurora.example', fetchText)
    expect(site.status).toBe('robots_disallowed')
    expect(calls).toEqual(['https://hotelaurora.example/robots.txt'])
  })

  it('indirizzo interno bloccato dalla protezione SSRF', async () => {
    const fetchText = (async () => {
      throw new SsrfError('blocked_address')
    }) as never
    expect((await readWebsite('https://intranet.example', fetchText)).status).toBe('blocked_address')
  })

  it('chiamata OpenAI con Structured Outputs e chiave solo nell’header server', async () => {
    const f = mockFetch(() => openAiResponse(modelOutput()))
    const fetchText = (async (url: string) => (url.endsWith('robots.txt') ? { url, status: 404, contentType: 'text/plain', body: '' } : { url, status: 200, contentType: 'text/html', body: `<html><title>Hotel Aurora Roma</title><body><p>${SITE.text}</p><p>info@hotelaurora.example</p></body></html>` })) as never
    const r = await analyzeCompany({ company, providerLabel: 'OSM', profile: hotelProfile, keywords: [], env: AI_ENV, fetchText, fetchImpl: f.fn })
    const req = JSON.parse(String(f.calls[0]!.init?.body))
    expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/responses')
    expect(req.text.format).toMatchObject({ type: 'json_schema', strict: true })
    expect(req.store).toBe(false)
    expect(JSON.stringify(req.input)).not.toContain('info@hotelaurora.example') // email rimosse prima dell'invio
    expect(r.usage).toEqual({ input_tokens: 900, output_tokens: 300 })
    expect(r.website.status).toBe('analyzed')
  })
})

describe('7. Gestione errori API OpenAI', () => {
  const base = { apiKey: 'k', model: 'm', system: 's', user: 'u', schemaName: 'x', schema: {}, timeoutMs: 1000 }
  const cases: [string, () => Response, string][] = [
    ['401', () => new Response('', { status: 401 }), 'ai_auth_failed'],
    ['429', () => new Response('', { status: 429 }), 'ai_rate_limited'],
    ['503', () => new Response('', { status: 503 }), 'ai_unavailable'],
    ['rifiuto', () => jsonResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), 'ai_refused'],
    ['incompleto', () => jsonResponse({ status: 'incomplete', output: [] }), 'ai_incomplete'],
    ['testo non JSON', () => jsonResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ciao' }] }] }), 'ai_bad_response'],
  ]
  for (const [name, handler, code] of cases) {
    it(`${name} → ${code}`, async () => {
      const err = await callStructured({ ...base, fetchImpl: mockFetch(handler).fn }).catch((e) => e)
      expect(err.code).toBe(code)
    })
  }
  it('senza chiave non viene effettuata alcuna chiamata', async () => {
    const f = mockFetch(() => jsonResponse({}))
    const err = await callStructured({ ...base, apiKey: '', fetchImpl: f.fn }).catch((e) => e)
    expect(err.code).toBe('ai_not_configured')
    expect(f.calls).toHaveLength(0)
  })
})

describe('Job di analisi: ciclo di vita, crediti e limiti', () => {
  async function seeded(quotaAi = 5) {
    const mem = createMemoryStore({ profiles: { [ORG_A]: hotelProfile }, quotas: { [ORG_A]: { monthly_searches: 10, monthly_results: 100, monthly_ai_analyses: quotaAi, requests_per_minute: 50 } } })
    const registry = createRegistry(OSM_ENV, mockFetch(() => jsonResponse(overpassBody)).fn)
    await runSearch({ store: mem.store, registry }, { orgId: ORG_A, userId: USER_A }, searchInput())
    return mem
  }

  it('AI non configurata → 409 con variabili mancanti', async () => {
    const { store, state } = await seeded()
    const err = await requestAnalysis({ store, env: {} }, { orgId: ORG_A, userId: USER_A }, { candidate_id: state.candidates[0]!.id, keywords: [] }).catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.details.missing).toEqual(['OPENAI_API_KEY', 'OPENAI_MODEL', 'LEADFLOW_INTERNAL_SECRET'])
  })

  it('successo: analisi e punteggio AI salvati, 1 credito consumato', async () => {
    const { store, state } = await seeded()
    const cand = state.candidates.find((c) => c.externalId === 'node/101')!
    const { job_id } = await requestAnalysis({ store, env: AI_ENV }, { orgId: ORG_A, userId: USER_A }, { candidate_id: cand.id, keywords: [] })
    const analyze = async () => verifyOutput(modelOutput(), SITE, company, 'OSM', { model: 'test-model', usage: { input_tokens: 1, output_tokens: 1 } })
    expect(await runAnalysisJob({ store, analyze }, job_id)).toBe('succeeded')
    expect(await runAnalysisJob({ store, analyze }, job_id)).toBe('skipped') // idempotente
    const updated = state.candidates.find((c) => c.id === cand.id)!
    expect(updated.scoreBasis).toBe('ai')
    expect(updated.analysis?.qualification_reason).toBe('Buona corrispondenza')
    expect(state.usage.filter((u) => u.event === 'ai_analysis').length).toBe(1)
    expect(state.jobs[0]!.status).toBe('succeeded')
  })

  it('errore AI: job fallito con codice, nessun credito consumato', async () => {
    const { store, state } = await seeded()
    const { job_id } = await requestAnalysis({ store, env: AI_ENV }, { orgId: ORG_A, userId: USER_A }, { candidate_id: state.candidates[0]!.id, keywords: [] })
    const analyze = async () => {
      const { AiError } = await import('../analysis/openai')
      throw new AiError('ai_rate_limited', true)
    }
    expect(await runAnalysisJob({ store, analyze }, job_id)).toBe('failed')
    expect(state.jobs[0]).toMatchObject({ status: 'failed', error: 'ai_rate_limited' })
    expect(state.usage.filter((u) => u.event === 'ai_analysis').length).toBe(0)
  })

  it('8. limite analisi: conteggia anche i lavori in corso', async () => {
    const { store, state } = await seeded(1)
    await requestAnalysis({ store, env: AI_ENV }, { orgId: ORG_A, userId: USER_A }, { candidate_id: state.candidates[0]!.id, keywords: [] })
    const err = await requestAnalysis({ store, env: AI_ENV }, { orgId: ORG_A, userId: USER_A }, { candidate_id: state.candidates[1]!.id, keywords: [] }).catch((e) => e)
    expect(err.code).toBe('quota_ai_exceeded')
  })

  it('Google: richiede i dati di sessione e non li conserva dopo l’analisi', async () => {
    const { store, state } = createMemoryStore({ profiles: { [ORG_A]: hotelProfile } })
    await store.writeCandidates(ORG_A, [{ provider: 'google_places', externalId: 'ChIJ', searchId: 's', canStoreContent: false, canExport: false, canSaveToCrm: false, attribution: 'Google Maps', sourceUrl: null, dedupKey: null, acquiredAt: '', content: null, score: null, keepExistingScore: false, isNew: true }])
    const id = state.candidates[0]!.id
    const missing = await requestAnalysis({ store, env: AI_ENV }, { orgId: ORG_A, userId: USER_A }, { candidate_id: id, keywords: [] }).catch((e) => e)
    expect(missing.code).toBe('ephemeral_data_required')
    const { job_id } = await requestAnalysis({ store, env: AI_ENV }, { orgId: ORG_A, userId: USER_A }, { candidate_id: id, keywords: [], ephemeral: { companyName: 'Hotel X', sector: 'Hotel', address: null, city: 'Roma', country: 'IT', website: 'hotelx.example', phone: null } })
    const analyze = async () => verifyOutput(modelOutput(), SITE, company, 'Google', { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } })
    await runAnalysisJob({ store, analyze }, job_id)
    const job = state.jobs[0]!
    expect(JSON.stringify(job.input)).not.toContain('Hotel X')
    expect((job.output as { score: { score: number } }).score.score).toBeGreaterThan(0)
    expect(state.candidates[0]!.analysis).toBeNull()
    expect(state.candidates[0]!.score).toBeNull()
  })
})
