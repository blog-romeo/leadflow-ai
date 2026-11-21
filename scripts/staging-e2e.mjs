#!/usr/bin/env node
/**
 * Test end-to-end REALE e limitato su STAGING (Prompt 10).
 *
 * Obiettivo: "Trova fino a 5 aziende alberghiere a Roma, analizzale e prepara fino a 3 proposte commerciali."
 * Usa le API pubbliche dell'app con un utente di TEST (accesso Supabase con email e password di prova):
 * stessi controlli di autenticazione, piano, crediti, flag e approvazioni dell'interfaccia.
 *
 * Garanzie:
 *  • massimo 5 aziende, massimo 3 proposte, budget in crediti da E2E_BUDGET_CREDITS (default 15);
 *  • nessun invio, nessun contatto, nessun pagamento (il motore non ha strumenti di invio);
 *  • il salvataggio nel CRM richiede l'approvazione: lo script si FERMA alla richiesta di approvazione,
 *    a meno che il proprietario non passi esplicitamente E2E_APPROVE=yes-approve-crm-write;
 *  • rifiuta di girare contro la produzione (CONTEXT=production o URL senza "staging"/"deploy-preview"
 *    se E2E_ALLOW_URL non è impostata);
 *  • nessun risultato inventato: il report contiene solo ciò che le API e il database restituiscono.
 *
 * Variabili: E2E_APP_URL, E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY, E2E_EMAIL, E2E_PASSWORD, E2E_ORG_ID,
 *            [E2E_BUDGET_CREDITS], [E2E_APPROVE], [E2E_ALLOW_URL], [E2E_TIMEOUT_MIN]
 * Uscita: report JSON su stdout e in e2e-report.json; codice 1 se il test non è completato.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const OBJECTIVE = 'Trova fino a 5 aziende alberghiere a Roma, analizzale e prepara fino a 3 proposte commerciali.'
export const LIMITS = { max_results: 5, analyze_top: 5, proposals_top: 3 }
const TERMINAL = ['completed', 'partial', 'failed', 'cancelled']

export function assertSafeTarget(env) {
  const url = (env.E2E_APP_URL ?? '').trim()
  if (!url.startsWith('https://')) throw new Error('E2E_APP_URL deve essere https://')
  if (env.CONTEXT === 'production') throw new Error('rifiutato: CONTEXT=production')
  if (!/staging|deploy-preview|--/i.test(url) && env.E2E_ALLOW_URL !== url) throw new Error('URL non riconosciuto come staging: impostare E2E_ALLOW_URL uguale a E2E_APP_URL per confermare')
  for (const k of ['E2E_SUPABASE_URL', 'E2E_SUPABASE_ANON_KEY', 'E2E_EMAIL', 'E2E_PASSWORD', 'E2E_ORG_ID']) if (!(env[k] ?? '').trim()) throw new Error(`${k} mancante`)
  return url.replace(/\/$/, '')
}

/** Parametri del test: limiti forzati qualunque cosa restituisca l'interpretazione dell'obiettivo. */
export function clampParams(params) {
  return { ...params, sector: params.sector ?? 'hotel', location: params.location ?? 'Roma', country: 'IT', provider: 'auto', ...LIMITS, max_results: Math.min(params.max_results ?? 5, 5), analyze_top: Math.min(params.analyze_top ?? 5, 5), proposals_top: Math.min(params.proposals_top ?? 3, 3) }
}

/** Riepilogo verificabile: solo dati restituiti da API e database. */
export function summarize({ workflow, steps, runs, approvals, timings, errors }) {
  const out = (a) => steps.find((s) => s.action === a)?.output ?? null
  const discover = out('discover')
  const score = out('score')
  const strategy = out('strategy')
  const research = out('research')
  const tokensIn = runs.reduce((a, r) => a + (r.tokens_input ?? 0), 0)
  const tokensOut = runs.reduce((a, r) => a + (r.tokens_output ?? 0), 0)
  const priced = runs.filter((r) => r.cost_usd !== null && r.cost_usd !== undefined)
  return {
    objective: OBJECTIVE,
    workflow: workflow ? { id: workflow.id, status: workflow.status, error_code: workflow.error_code, credits_used: workflow.credits_used, budget_credits: workflow.budget_credits, cost_usd: workflow.cost_usd } : null,
    companies_found: discover ? { provider: discover.provider ?? null, attribution: discover.attribution ?? null, counts: discover.counts ?? null } : 'PROVIDER_NOT_CONFIGURED_OR_NOT_RUN',
    ranking: score?.ranked ? score.ranked.map((r) => ({ company_name: r.company_name, city: r.city, website: r.website, score: r.score, priority: r.priority, basis: r.basis, missing: r.missing })) : [],
    analysis: research?.counts ?? null,
    proposals: strategy?.strategies ? strategy.strategies.map((s) => ({ company_name: s.company_name, status: s.status, basis: s.strategy?.opportunity?.basis ?? null, warnings: (s.warnings ?? []).map((w) => w.code), draft_saved: !!s.draft_id })) : [],
    no_messages_sent: strategy ? strategy.no_messages_sent === true : true,
    approvals: approvals.map((a) => ({ action: a.action, status: a.status })),
    tokens: { input: tokensIn, output: tokensOut },
    cost_usd: priced.length ? Math.round(priced.reduce((a, r) => a + Number(r.cost_usd), 0) * 1e6) / 1e6 : 'not_measurable_prices_not_configured',
    step_durations_ms: steps.map((s) => ({ action: s.action, status: s.status, error_code: s.error_code, ms: s.started_at && s.completed_at ? Date.parse(s.completed_at) - Date.parse(s.started_at) : null })),
    store_calls_last_invocation: workflow?.report?.perf_last_invocation ?? null,
    timings_ms: timings,
    errors,
  }
}

async function main(env = process.env) {
  const app = assertSafeTarget(env)
  const sb = env.E2E_SUPABASE_URL.trim().replace(/\/$/, '')
  const anon = env.E2E_SUPABASE_ANON_KEY.trim()
  const org = env.E2E_ORG_ID.trim()
  const budget = Math.min(Math.max(Number(env.E2E_BUDGET_CREDITS ?? 15) || 15, 0), 50)
  const timeoutMs = Math.min(Number(env.E2E_TIMEOUT_MIN ?? 20) || 20, 60) * 60_000
  const errors = []
  const timings = {}
  const t = () => Date.now()

  const login = await fetch(`${sb}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: env.E2E_EMAIL, password: env.E2E_PASSWORD }) })
  if (!login.ok) throw new Error(`login fallito: HTTP ${login.status}`)
  const { access_token: jwt } = await login.json()
  const api = async (path, body) => {
    const t0 = t()
    const res = await fetch(`${app}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const data = await res.json().catch(() => ({}))
    timings[path.split('?')[0]] = t() - t0
    if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status} ${data?.error ?? ''}`), { data })
    return data
  }
  const rest = async (table, query) => {
    const res = await fetch(`${sb}/rest/v1/${table}?${query}`, { headers: { apikey: anon, authorization: `Bearer ${jwt}` } })
    if (!res.ok) throw new Error(`lettura ${table}: HTTP ${res.status}`)
    return res.json()
  }

  const status = await api(`/api/ai-agents/status?organization_id=${org}`)
  if (!status.enabled) throw new Error('motore multi-agent non attivo per questa organizzazione (AI_AGENTS_ENABLED / AI_AGENTS_PILOT_ORGS)')
  const plan = await api('/api/ai-workflows/plan', { organization_id: org, objective: OBJECTIVE })
  if (!plan.plan) throw new Error(`piano non valido: ${JSON.stringify(plan.invalid_fields ?? [])}`)
  const params = clampParams(plan.plan.params)
  let started
  const tStart = t()
  try {
    started = await api('/api/ai-workflows/start', { organization_id: org, template: 'prospecting', objective: OBJECTIVE, params, budget_credits: budget, idempotency_key: `e2e-${new Date().toISOString().slice(0, 16).replace(/[^0-9]/g, '')}` })
  } catch (e) {
    // Piano bloccato (es. PROVIDER_NOT_CONFIGURED): riportato così com'è, nessun dato simulato.
    const report = summarize({ workflow: null, steps: [], runs: [], approvals: [], timings, errors: [{ stage: 'start', message: e.message, missing: e.data?.missing ?? null }] })
    return { ok: false, report }
  }
  const wid = started.workflow_id
  const poll = async () => (await rest('ai_workflows', `id=eq.${wid}&organization_id=eq.${org}&select=*`))[0]
  let wf = await poll()
  let approved = false
  const deadline = t() + timeoutMs
  while (t() < deadline) {
    wf = await poll()
    if (TERMINAL.includes(wf.status)) break
    if (wf.status === 'waiting_approval') {
      timings.until_approval = timings.until_approval ?? t() - tStart
      if (env.E2E_APPROVE !== 'yes-approve-crm-write' || approved) break
      const [ap] = await rest('ai_agent_approvals', `workflow_id=eq.${wid}&status=eq.pending&select=id`)
      if (ap) {
        await api('/api/ai-workflows/control', { organization_id: org, workflow_id: wid, action: 'approve', approval_id: ap.id, note: 'Approvato dal proprietario per il test e2e di staging' })
        approved = true
      }
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  timings.workflow_total = t() - tStart
  const [steps, runs, approvals] = await Promise.all([
    rest('ai_workflow_steps', `workflow_id=eq.${wid}&organization_id=eq.${org}&select=*&order=position`),
    rest('ai_agent_runs', `workflow_id=eq.${wid}&organization_id=eq.${org}&select=agent_key,status,error_code,credits_used,tokens_input,tokens_output,cost_usd,model,started_at,completed_at`),
    rest('ai_agent_approvals', `workflow_id=eq.${wid}&organization_id=eq.${org}&select=action,status`),
  ])
  for (const s of steps) if (s.error_code && s.error_code !== 'nothing_to_approve') errors.push({ stage: s.action, code: s.error_code })
  const report = summarize({ workflow: wf, steps, runs, approvals, timings, errors })
  const ok = wf.status === 'completed' || (wf.status === 'waiting_approval' && env.E2E_APPROVE !== 'yes-approve-crm-write')
  return { ok, report }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { ok, report } = await main()
    writeFileSync('e2e-report.json', JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (report.workflow?.status === 'waiting_approval') console.log('\nFermo all\'approvazione: nessun lead salvato. Approvare dall\'interfaccia o rilanciare con E2E_APPROVE=yes-approve-crm-write.')
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error(`e2e: ${e.message}`)
    process.exit(1)
  }
}
