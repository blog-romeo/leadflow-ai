// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertSafeTarget, clampParams, summarize } from '../../scripts/staging-e2e.mjs'
import { TABLES, evaluate } from '../../scripts/staging-isolation.mjs'

const ENV = { E2E_APP_URL: 'https://staging--leadflow.netlify.app', E2E_SUPABASE_URL: 'https://x.supabase.co', E2E_SUPABASE_ANON_KEY: 'a', E2E_EMAIL: 'test@example.test', E2E_PASSWORD: 'p', E2E_ORG_ID: '00000000-0000-4000-8000-000000000001' }

describe('test e2e di staging (Prompt 10)', () => {
  it('rifiuta la produzione e gli URL non di staging', () => {
    expect(assertSafeTarget(ENV)).toBe('https://staging--leadflow.netlify.app')
    expect(() => assertSafeTarget({ ...ENV, CONTEXT: 'production' })).toThrow('production')
    expect(() => assertSafeTarget({ ...ENV, E2E_APP_URL: 'https://leadflow.example' })).toThrow('staging')
    expect(assertSafeTarget({ ...ENV, E2E_APP_URL: 'https://beta.leadflow.example', E2E_ALLOW_URL: 'https://beta.leadflow.example' })).toBe('https://beta.leadflow.example')
    expect(() => assertSafeTarget({ ...ENV, E2E_PASSWORD: '' })).toThrow('E2E_PASSWORD')
  })
  it('limiti forzati: 5 aziende, 3 proposte', () => {
    expect(clampParams({ sector: 'hotel', location: 'Roma', max_results: 30, analyze_top: 30, proposals_top: 10 })).toMatchObject({ max_results: 5, analyze_top: 5, proposals_top: 3, country: 'IT' })
  })
  it('report: nessun dato inventato quando il provider non restituisce nulla', () => {
    const r = summarize({ workflow: null, steps: [], runs: [], approvals: [], timings: {}, errors: [{ stage: 'start', message: 'plan_blocked' }] })
    expect(r).toMatchObject({ companies_found: 'PROVIDER_NOT_CONFIGURED_OR_NOT_RUN', ranking: [], proposals: [], cost_usd: 'not_measurable_prices_not_configured', tokens: { input: 0, output: 0 } })
  })
})

describe('test di isolamento di staging (Prompt 10)', () => {
  it('copre le tabelle commerciali e del motore multi-agent', () => {
    for (const t of ['leads', 'ai_workflows', 'ai_research_evidence', 'ai_company_memory', 'audit_logs']) expect(TABLES).toContain(t)
  })
  it('un solo controllo fallito fa fallire il test', () => {
    expect(evaluate([{ check: 'a', pass: true }, { check: 'b', pass: false }])).toMatchObject({ passed: 1, failed: 1 })
  })
})

describe('smoke test di staging (Prompt 11)', () => {
  it('solo staging e header di sicurezza richiesti', async () => {
    const { assertStaging, checkHeaders, REQUIRED_HEADERS } = await import('../../scripts/staging-smoke.mjs')
    expect(assertStaging({ SMOKE_APP_URL: 'https://staging--leadflow.netlify.app/' })).toBe('https://staging--leadflow.netlify.app')
    expect(() => assertStaging({ SMOKE_APP_URL: 'https://leadflow.example' })).toThrow('staging')
    expect(() => assertStaging({ SMOKE_APP_URL: 'https://staging.example', CONTEXT: 'production' })).toThrow('production')
    expect(checkHeaders(new Headers(Object.fromEntries(REQUIRED_HEADERS.map((h) => [h, 'x']))))).toEqual([])
    expect(checkHeaders(new Headers({ 'x-frame-options': 'DENY' }))).toContain('content-security-policy')
  })
  it('netlify.toml dichiara tutti gli header controllati dallo smoke test', async () => {
    const { readFileSync } = await import('node:fs')
    const { REQUIRED_HEADERS } = await import('../../scripts/staging-smoke.mjs')
    const toml = readFileSync('netlify.toml', 'utf8').toLowerCase()
    for (const h of REQUIRED_HEADERS) expect(toml).toContain(h)
  })
})
