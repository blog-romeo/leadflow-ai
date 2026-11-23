import { openaiBaseUrl } from '../lead-finder/analysis/openai'
import { fetchWithTimeout, TimeoutError } from '../fetchTimeout'
import { tierModel } from './models'

/**
 * Verifica REALE delle connessioni (Prompt 10). "Configurato" (variabili presenti) non significa
 * "connesso": questo modulo esegue chiamate di SOLA LETTURA che non consumano token né crediti e non
 * creano dati presso il provider:
 *  • OpenAI: GET /v1/models/<modello> per ogni livello configurato (il modello esiste per questa chiave);
 *  • Overpass: GET .../status (stato del servizio e slot disponibili);
 *  • Google Places: non verificato qui (escluso dai workflow per licenza; ogni chiamata è a pagamento).
 * Nessun segreto nei risultati: solo stato, codice e latenza.
 */
export type ConnectionKey = 'openai_standard' | 'openai_economy' | 'openai_advanced' | 'overpass'
export type ConnectionState = 'verified' | 'failed' | 'not_configured'

export interface ConnectionResult {
  key: ConnectionKey
  state: ConnectionState
  /** Codice stabile: ok, provider_not_configured, auth_failed, model_not_found, rate_limited, unavailable, timeout, network_error. */
  code: string
  latency_ms: number | null
}

const TIERS = [
  ['openai_standard', 'standard'],
  ['openai_economy', 'economy'],
  ['openai_advanced', 'advanced'],
] as const

function codeFor(status: number): string {
  if (status === 200) return 'ok'
  if (status === 401 || status === 403) return 'auth_failed'
  if (status === 404) return 'model_not_found'
  if (status === 429) return 'rate_limited'
  return status >= 500 ? 'unavailable' : `http_${status}`
}

async function timed(fn: () => Promise<Response>): Promise<{ status: number; ms: number; error?: string }> {
  const t0 = Date.now()
  try {
    const res = await fn()
    // Il corpo non serve: lo si scarta senza leggerlo nei log.
    await res.body?.cancel().catch(() => undefined)
    return { status: res.status, ms: Date.now() - t0 }
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, error: err instanceof TimeoutError ? 'timeout' : 'network_error' }
  }
}

export async function checkConnections(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<ConnectionResult[]> {
  const out: ConnectionResult[] = []
  const key = (env.OPENAI_API_KEY ?? '').trim()
  for (const [k, tier] of TIERS) {
    const model = tierModel(tier, env)
    if (!key || !model) {
      out.push({ key: k, state: 'not_configured', code: 'provider_not_configured', latency_ms: null })
      continue
    }
    const r = await timed(() => fetchWithTimeout(`${openaiBaseUrl(env)}/models/${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${key}` } }, timeoutMs, fetchImpl))
    out.push({ key: k, state: r.status === 200 ? 'verified' : 'failed', code: r.error ?? codeFor(r.status), latency_ms: r.ms })
  }
  const overpass = (env.OVERPASS_API_URL ?? '').trim()
  const contact = (env.OVERPASS_CONTACT ?? '').trim()
  if (!overpass || !contact) {
    out.push({ key: 'overpass', state: 'not_configured', code: 'provider_not_configured', latency_ms: null })
  } else {
    const statusUrl = overpass.replace(/\/interpreter\/?$/, '/status')
    const headers: Record<string, string> = { 'user-agent': `LeadFlowAI/1.0 (+${contact})` }
    // Istanze a pagamento o self-hosted (consigliate per l'uso commerciale): stessa chiave dell'adapter.
    if ((env.OVERPASS_API_KEY ?? '').trim()) headers.authorization = `Bearer ${env.OVERPASS_API_KEY!.trim()}`
    const r = await timed(() => fetchWithTimeout(statusUrl, { headers }, timeoutMs, fetchImpl))
    out.push({ key: 'overpass', state: r.status === 200 ? 'verified' : 'failed', code: r.error ?? codeFor(r.status), latency_ms: r.ms })
  }
  return out
}
