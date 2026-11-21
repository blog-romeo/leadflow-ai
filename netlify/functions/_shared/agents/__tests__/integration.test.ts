// @vitest-environment node
/**
 * Prompt 10 — integrazione con i provider (tutte le risposte HTTP sono FINTE, generate dal test:
 * verificano la gestione di timeout, rate limit, errori, token e segreti, non i servizi reali).
 */
import { describe, expect, it } from 'vitest'
import { AiError, callStructured, retryAfterSeconds } from '../../lead-finder/analysis/openai'
import { log, redact, redactString } from '../../log'
import { checkConnections } from '../connections'
import { runWorkflow } from '../engine'
import { makeHarness, prospecting, ORG_A } from './harness'

const fake = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch
const base = { apiKey: 'k', model: 'm', system: 's', user: 'u', schemaName: 'x', schema: {}, timeoutMs: 1000 }

describe('OpenAI: errori, rate limit e contabilità dei token', () => {
  it('429 con Retry-After: errore ritentabile con attesa indicata', async () => {
    const err = await callStructured({ ...base, fetchImpl: fake(429, {}, { 'retry-after': '7' }) }).catch((e) => e)
    expect(err).toBeInstanceOf(AiError)
    expect([err.code, err.retryable, err.details.retry_after]).toEqual(['ai_rate_limited', true, 7])
    expect(retryAfterSeconds('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:30 GMT'))).toBe(30)
    expect(retryAfterSeconds('abc')).toBeNull()
  })
  it('risposta troncata: i token consumati sono riportati', async () => {
    const err = await callStructured({ ...base, fetchImpl: fake(200, { status: 'incomplete', usage: { input_tokens: 900, output_tokens: 3000 } }) }).catch((e) => e)
    expect([err.code, err.details.usage]).toEqual(['ai_incomplete', { input_tokens: 900, output_tokens: 3000 }])
  })
  it('chiave non valida: errore permanente (nessun retry)', async () => {
    const err = await callStructured({ ...base, fetchImpl: fake(401) }).catch((e) => e)
    expect([err.code, err.retryable]).toEqual(['ai_auth_failed', false])
  })
  it('strategia troncata: crediti rimborsati, token registrati come costo con 0 crediti', async () => {
    const h = makeHarness({ ai: async () => { throw new AiError('ai_incomplete', false, { usage: { input_tokens: 1200, output_tokens: 3000 } }) } })
    const { workflow_id } = await h.start('prospecting', prospecting())
    await runWorkflow(h.engineDeps, workflow_id)
    h.agents.rpc.decide(h.approvalFor(workflow_id)!.id, ORG_A, 'approve')
    await runWorkflow(h.engineDeps, workflow_id)
    const lost = h.agents.state.costs.filter((c) => c.agentKey === 'strategy')
    expect(lost.length).toBe(2)
    expect(lost.every((c) => c.credits === 0 && c.tokensInput === 1200 && c.tokensOutput === 3000)).toBe(true)
    // Solo le analisi (1 credito ciascuna) sono addebitate: le strategie fallite non consumano crediti.
    const analyzed = (h.steps(workflow_id)[1]!.output!.counts as { analyzed: number }).analyzed
    expect(analyzed).toBeGreaterThan(0)
    expect(h.workflow(workflow_id).creditsUsed).toBe(analyzed)
  })
})

describe('Log sicuri', () => {
  it('chiavi e token oscurati anche nei valori', () => {
    const s = redactString('Invalid key sk-proj-abcdefghijklmnop1234 and sk_live_51ABCDEFGHijkl whsec_abcdefgh123 Bearer abc.def.ghi1234 eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl ghp_abcdefghijklmnopqrstuvwx')
    expect(s).not.toMatch(/sk-proj|sk_live|whsec_|Bearer abc|eyJhbG|ghp_/)
    expect(redact({ nested: { message: 'token re_abcdefghijklmnopqrst' } })).toEqual({ nested: { message: 'token [redacted-secret]' } })
    expect(redact({ authorization: 'x', count: 3 })).toEqual({ authorization: '[redacted]', count: 3 })
  })
  it('il logger non scrive segreti', () => {
    const lines: string[] = []
    const orig = console.info
    console.info = (l: string) => void lines.push(l)
    try {
      log('info', 'test.event', { detail: 'chiave sk-abcdefghijklmnopqrstuv' })
    } finally {
      console.info = orig
    }
    expect(lines.join('')).not.toContain('sk-abcdefghijklmnopqrstuv')
  })
})

describe('Verifica connessioni (sola lettura)', () => {
  it('nessuna configurazione: PROVIDER_NOT_CONFIGURED e nessuna chiamata', async () => {
    let calls = 0
    const r = await checkConnections({}, (async () => { calls++; return new Response('{}') }) as unknown as typeof fetch)
    expect(r.every((x) => x.state === 'not_configured' && x.code === 'provider_not_configured')).toBe(true)
    expect(calls).toBe(0)
  })
  it('modelli e Overpass verificati con GET, mai generazioni; segreti assenti dai risultati', async () => {
    const urls: { url: string; method: string }[] = []
    const f = (async (url: string, init?: RequestInit) => {
      urls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/v1/models/missing-model')) return new Response('{}', { status: 404 })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const r = await checkConnections({ OPENAI_API_KEY: 'sk-segretissima-0000000000', OPENAI_MODEL: 'std', OPENAI_MODEL_ADVANCED: 'missing-model', OVERPASS_API_URL: 'https://overpass.example/api/interpreter', OVERPASS_CONTACT: 'ops@example.test' }, f)
    expect(Object.fromEntries(r.map((x) => [x.key, `${x.state}:${x.code}`]))).toEqual({ openai_standard: 'verified:ok', openai_economy: 'not_configured:provider_not_configured', openai_advanced: 'failed:model_not_found', overpass: 'verified:ok' })
    expect(urls.every((u) => u.method === 'GET')).toBe(true)
    expect(urls.some((u) => u.url.endsWith('/api/status'))).toBe(true)
    expect(JSON.stringify(r)).not.toContain('segretissima')
  })
  it('timeout ed errori di rete riportati come codici', async () => {
    const f = (async (_u: string, init?: RequestInit) => new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))) as unknown as typeof fetch
    const r = await checkConnections({ OVERPASS_API_URL: 'https://overpass.example/api/interpreter', OVERPASS_CONTACT: 'x' }, f, 20)
    expect(r.find((x) => x.key === 'overpass')).toMatchObject({ state: 'failed', code: 'timeout' })
  })
})

describe('Misura delle chiamate allo store per invocazione', () => {
  it('il report contiene le chiamate allo store dell\'ultima invocazione', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('growth_report', {})
    await runWorkflow(h.engineDeps, workflow_id)
    const perf = (h.workflow(workflow_id).report as Record<string, unknown>).perf_last_invocation as { store_calls: number; invocation_ms: number }
    expect(perf.store_calls).toBeGreaterThan(0)
    expect(perf.invocation_ms).toBeGreaterThanOrEqual(0)
  })
})
