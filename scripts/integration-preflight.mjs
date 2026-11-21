#!/usr/bin/env node
/**
 * Preflight delle integrazioni di staging (Prompt 9) — SOLO LETTURA.
 *
 * Senza rete (default) verifica la presenza e la forma della configurazione. Con PREFLIGHT_NETWORK=1
 * esegue chiamate di sola lettura che NON creano dati, NON consumano crediti AI e NON toccano Stripe:
 *  - Supabase: raggiungibilità REST con la chiave anon e presenza delle RPC delle migrazioni 0012/0013
 *    (una RPC esistente risponde "forbidden" alla chiave anon, una mancante risponde 404);
 *  - OpenAI: GET /v1/models/<modello> per ogni livello configurato (il modello deve esistere per la chiave:
 *    nessun nome di modello inventato). Nessuna generazione, nessun token consumato;
 *  - Overpass: endpoint /status;
 *  - Netlify: GET <APP_URL>/api/health.
 * Stripe è verificato a parte da `npm run stripe:preflight` (solo modalità test); qui si controlla soltanto
 * che la chiave NON sia live.
 *
 * I valori dei segreti non vengono mai stampati. Esce con codice 1 se c'è almeno un errore.
 * Uso:  node --env-file=.env.staging scripts/integration-preflight.mjs   (PREFLIGHT_NETWORK=1 per le chiamate)
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const has = (env, k) => typeof env[k] === 'string' && env[k].trim() !== ''
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Controlli statici della configurazione (nessuna rete). */
export function checkConfig(env) {
  const out = []
  const push = (area, level, msg) => out.push({ area, level, msg })
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
    if (!has(env, k)) push('supabase', 'error', `${k} mancante`)
  }
  if (has(env, 'SUPABASE_URL') && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(env.SUPABASE_URL.trim())) push('supabase', 'warn', 'SUPABASE_URL non nel formato https://<ref>.supabase.co')
  if (has(env, 'SUPABASE_URL') && has(env, 'VITE_SUPABASE_URL') && env.SUPABASE_URL.trim() !== env.VITE_SUPABASE_URL.trim()) push('supabase', 'error', 'SUPABASE_URL e VITE_SUPABASE_URL puntano a progetti diversi')

  const key = (env.STRIPE_SECRET_KEY ?? '').trim()
  if (/^(sk|rk)_live_/.test(key)) push('stripe', 'error', 'chiave Stripe LIVE in staging: rimuoverla (solo modalità test)')
  else if (!key) push('stripe', 'warn', 'STRIPE_SECRET_KEY mancante (billing non verificabile)')
  else if (!/^(sk|rk)_test_/.test(key)) push('stripe', 'error', 'STRIPE_SECRET_KEY non riconosciuta')
  if (key && !has(env, 'STRIPE_WEBHOOK_SECRET')) push('stripe', 'error', 'STRIPE_WEBHOOK_SECRET mancante: gli eventi non sarebbero verificati')

  if (!has(env, 'OPENAI_API_KEY')) push('openai', 'warn', 'OPENAI_API_KEY mancante: Research e Strategy bloccati (nessuna simulazione)')
  if (has(env, 'OPENAI_API_KEY') && !has(env, 'OPENAI_MODEL')) push('openai', 'error', 'OPENAI_MODEL mancante')
  if (has(env, 'OPENAI_API_KEY') && !(has(env, 'OPENAI_PRICE_INPUT_PER_MTOK') && has(env, 'OPENAI_PRICE_OUTPUT_PER_MTOK'))) push('openai', 'warn', 'prezzi OPENAI_PRICE_* non configurati: costi registrati come NULL')

  if (!(has(env, 'OVERPASS_API_URL') && has(env, 'OVERPASS_CONTACT'))) push('provider_b2b', 'warn', 'OVERPASS_API_URL/OVERPASS_CONTACT mancanti: Discovery bloccato (nessuna ricerca simulata)')
  if ((env.LEADFLOW_INTERNAL_SECRET ?? '').length < 32) push('netlify', 'error', 'LEADFLOW_INTERNAL_SECRET assente o < 32 caratteri (dispatch dei workflow)')
  if (!has(env, 'APP_URL') && !has(env, 'URL')) push('netlify', 'warn', 'APP_URL mancante')

  if (env.AI_AGENTS_ENABLED === 'true') {
    const pilots = (env.AI_AGENTS_PILOT_ORGS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!pilots.length) push('agents', 'warn', 'AI_AGENTS_ENABLED=true senza AI_AGENTS_PILOT_ORGS: beta aperta a tutte le organizzazioni')
    if (pilots.some((p) => !UUID.test(p))) push('agents', 'error', 'AI_AGENTS_PILOT_ORGS contiene valori non UUID')
  }
  if (env.CONTEXT === 'production' && env.AI_AGENTS_ENABLED === 'true') push('agents', 'warn', 'motore multi-agent attivo in produzione: REL-28 è ancora aperto')
  return out
}

async function probe(fetchImpl, url, init = {}) {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) })
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  } catch (e) {
    return { status: 0, error: e?.name === 'TimeoutError' ? 'timeout' : 'network_error' }
  }
}

/** Chiamate di sola lettura (solo con PREFLIGHT_NETWORK=1). */
export async function checkNetwork(env, fetchImpl = fetch) {
  const out = []
  const push = (area, level, msg) => out.push({ area, level, msg })
  if (has(env, 'SUPABASE_URL') && has(env, 'SUPABASE_ANON_KEY')) {
    const base = env.SUPABASE_URL.trim().replace(/\/$/, '')
    const headers = { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${env.SUPABASE_ANON_KEY}`, 'content-type': 'application/json' }
    const root = await probe(fetchImpl, `${base}/rest/v1/`, { headers })
    push('supabase', root.status >= 200 && root.status < 500 ? 'ok' : 'error', `REST raggiungibile: HTTP ${root.status || root.error}`)
    for (const [fn, mig] of [['ai_agent_spend', '0012'], ['sa_ai_monitoring', '0013']]) {
      const r = await probe(fetchImpl, `${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: '{}' })
      const missing = r.status === 404 && /PGRST202|Could not find/.test(JSON.stringify(r.body ?? ''))
      push('supabase', missing ? 'error' : r.status === 0 ? 'error' : 'ok', missing ? `migrazione ${mig} non applicata (RPC ${fn} assente)` : `RPC ${fn} presente (risposta alla chiave anon: HTTP ${r.status || r.error})`)
    }
  }
  if (has(env, 'OPENAI_API_KEY')) {
    for (const [tier, k] of [['standard', 'OPENAI_MODEL'], ['economy', 'OPENAI_MODEL_ECONOMY'], ['advanced', 'OPENAI_MODEL_ADVANCED']]) {
      if (!has(env, k)) continue
      const r = await probe(fetchImpl, `https://api.openai.com/v1/models/${encodeURIComponent(env[k].trim())}`, { headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } })
      push('openai', r.status === 200 ? 'ok' : 'error', r.status === 200 ? `modello del livello ${tier} disponibile` : r.status === 401 ? 'chiave OpenAI non valida' : `modello del livello ${tier} non disponibile per questa chiave (HTTP ${r.status || r.error})`)
    }
  }
  if (has(env, 'OVERPASS_API_URL')) {
    const statusUrl = env.OVERPASS_API_URL.trim().replace(/\/interpreter\/?$/, '/status')
    const r = await probe(fetchImpl, statusUrl, { headers: { 'user-agent': `LeadFlowAI-preflight (${env.OVERPASS_CONTACT ?? 'n/d'})` } })
    push('provider_b2b', r.status === 200 ? 'ok' : 'warn', `Overpass status: HTTP ${r.status || r.error}`)
  }
  const app = (env.APP_URL ?? env.URL ?? '').trim().replace(/\/$/, '')
  if (app) {
    const r = await probe(fetchImpl, `${app}/api/health`)
    push('netlify', r.status === 200 ? 'ok' : 'error', `${app}/api/health: HTTP ${r.status || r.error}`)
  }
  return out
}

export async function runIntegrationPreflight(env = process.env, fetchImpl = fetch) {
  const issues = checkConfig(env)
  const network = env.PREFLIGHT_NETWORK === '1' ? await checkNetwork(env, fetchImpl) : []
  const all = [...issues, ...network]
  return { network_checks: env.PREFLIGHT_NETWORK === '1', errors: all.filter((i) => i.level === 'error').length, issues: all }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runIntegrationPreflight()
  for (const i of r.issues) console.log(`${i.level === 'ok' ? '✓' : i.level === 'warn' ? '!' : '✗'} [${i.area}] ${i.msg}`)
  if (!r.network_checks) console.log('(solo configurazione: impostare PREFLIGHT_NETWORK=1 per le chiamate di sola lettura)')
  console.log(r.errors ? `\n${r.errors} errori bloccanti.` : '\nNessun errore bloccante.')
  process.exit(r.errors ? 1 : 0)
}
