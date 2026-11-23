import type { ModelTier } from './types'

/**
 * Selezione configurabile dei modelli per livello. Nessun nome di modello né prezzo nel codice:
 *
 *   standard → OPENAI_MODEL (obbligatorio, già usato da Analyzer e Sales Agent)
 *   economy  → OPENAI_MODEL_ECONOMY  (facoltativo; se assente si usa OPENAI_MODEL)
 *   advanced → OPENAI_MODEL_ADVANCED (facoltativo; se assente si usa OPENAI_MODEL)
 *
 * Prezzi (USD per milione di token) per livello: OPENAI_PRICE_{INPUT,OUTPUT}_PER_MTOK[_ECONOMY|_ADVANCED].
 * Se il prezzo del modello effettivamente usato non è configurato, il costo resta NULL ("non configurato").
 */
export interface ModelChoice {
  requested: ModelTier
  effective: ModelTier
  model: string | null
  /** true se il livello richiesto non è configurato ed è stato usato il modello standard. */
  fallback: boolean
}

const SUFFIX: Record<ModelTier, string> = { economy: '_ECONOMY', standard: '', advanced: '_ADVANCED' }

export function chooseModel(tier: ModelTier, env: NodeJS.ProcessEnv = process.env): ModelChoice {
  const standard = (env.OPENAI_MODEL ?? '').trim() || null
  if (tier === 'standard') return { requested: tier, effective: 'standard', model: standard, fallback: false }
  const specific = (env[`OPENAI_MODEL${SUFFIX[tier]}`] ?? '').trim()
  if (specific) return { requested: tier, effective: tier, model: specific, fallback: false }
  return { requested: tier, effective: 'standard', model: standard, fallback: true }
}

/** Prezzi del livello effettivo; null se non configurati o non validi. */
export function tierPrices(tier: ModelTier, env: NodeJS.ProcessEnv = process.env): { input: number; output: number } | null {
  const rawIn = env[`OPENAI_PRICE_INPUT_PER_MTOK${SUFFIX[tier]}`]
  const rawOut = env[`OPENAI_PRICE_OUTPUT_PER_MTOK${SUFFIX[tier]}`]
  if (!rawIn || !rawOut) return null
  const input = Number(rawIn)
  const output = Number(rawOut)
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null
  return { input, output }
}

export function estimateTierCost(usage: { input_tokens: number; output_tokens: number }, tier: ModelTier, env: NodeJS.ProcessEnv = process.env): number | null {
  const p = tierPrices(tier, env)
  if (!p) return null
  return Math.round(((usage.input_tokens * p.input + usage.output_tokens * p.output) / 1_000_000) * 1e6) / 1e6
}

/**
 * Ambiente "riscritto" per riusare i moduli esistenti (Analyzer, Sales Agent) che leggono OPENAI_MODEL e
 * OPENAI_PRICE_*: modello e prezzi diventano quelli del livello effettivo. I segreti non vengono copiati
 * oltre a quelli già necessari ai moduli riusati.
 */
export function envForTier(tier: ModelTier, env: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; choice: ModelChoice } {
  const choice = chooseModel(tier, env)
  const prices = tierPrices(choice.effective, env)
  const out: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    OPENAI_MODEL: choice.model ?? '',
    LEADFLOW_INTERNAL_SECRET: env.LEADFLOW_INTERNAL_SECRET,
    OPENAI_PRICE_INPUT_PER_MTOK: prices ? String(prices.input) : '',
    OPENAI_PRICE_OUTPUT_PER_MTOK: prices ? String(prices.output) : '',
  }
  return { env: out, choice }
}

// ════════════════════════════════════════════════════════════════════════════
// Intelligent Agent Routing (Prompt 9): modello scelto in base al COMPITO
// ════════════════════════════════════════════════════════════════════════════
/**
 * Ogni compito AI ha un livello preferito, un livello MINIMO e i fallback ammessi. Nessun nome di modello
 * o prezzo nel codice: i livelli sono risolti dalle variabili d'ambiente server-side (OPENAI_MODEL,
 * OPENAI_MODEL_ECONOMY, OPENAI_MODEL_ADVANCED). Regole:
 *  • la configurazione dell'organizzazione (ai_agents.model_tier) può alzare il livello, mai scendere
 *    sotto il minimo del compito (es. la strategia commerciale non usa mai il livello "economy");
 *  • l'override di piattaforma AI_ROUTE_<COMPITO>=economy|standard|advanced (server-side) è soggetto
 *    allo stesso minimo;
 *  • il fallback avviene solo verso livelli ammessi per il compito e solo se il livello richiesto non ha
 *    un modello configurato. Non c'è fallback dopo un errore del modello: un errore resta un errore
 *    (evita doppie chiamate e doppio consumo di crediti).
 */
export type AiTask = 'classification' | 'summary' | 'company_analysis' | 'sales_strategy' | 'follow_up_draft'
export const AI_TASKS: AiTask[] = ['classification', 'summary', 'company_analysis', 'sales_strategy', 'follow_up_draft']

export interface TaskRoute {
  preferred: ModelTier
  minimum: ModelTier
  /** Ordine dei fallback ammessi (tutti ≥ minimo). */
  fallbacks: ModelTier[]
}

export const TASK_ROUTES: Record<AiTask, TaskRoute> = {
  // Classificazione semplice e riassunti: modello leggero; se manca, quello standard.
  classification: { preferred: 'economy', minimum: 'economy', fallbacks: ['standard'] },
  summary: { preferred: 'economy', minimum: 'economy', fallbacks: ['standard'] },
  // Analisi aziendale = estrazione strutturata dal sito con evidenze: economico se configurato.
  company_analysis: { preferred: 'economy', minimum: 'economy', fallbacks: ['standard', 'advanced'] },
  // Strategia commerciale: ragionamento → avanzato; minimo standard; mai economy.
  sales_strategy: { preferred: 'advanced', minimum: 'standard', fallbacks: ['standard'] },
  follow_up_draft: { preferred: 'economy', minimum: 'economy', fallbacks: ['standard'] },
}

const RANK: Record<ModelTier, number> = { economy: 0, standard: 1, advanced: 2 }
const TIERS: ModelTier[] = ['economy', 'standard', 'advanced']
const isTier = (v: unknown): v is ModelTier => typeof v === 'string' && (TIERS as string[]).includes(v)

/** Modello configurato per un livello, SENZA fallback implicito (null se la variabile è vuota). */
export function tierModel(tier: ModelTier, env: NodeJS.ProcessEnv = process.env): string | null {
  return (env[`OPENAI_MODEL${SUFFIX[tier]}`] ?? '').trim() || null
}

export interface RouteDecision {
  task: AiTask
  requested: ModelTier
  effective: ModelTier
  model: string | null
  fallback: boolean
  /** Motivo della scelta (per l'osservabilità; nessun segreto). */
  reason: 'preferred' | 'org_config' | 'platform_override' | 'raised_to_minimum' | 'not_configured'
}

export function routeModel(task: AiTask, orgTier: ModelTier | null | undefined, env: NodeJS.ProcessEnv = process.env): RouteDecision {
  const route = TASK_ROUTES[task]
  const override = (env[`AI_ROUTE_${task.toUpperCase()}`] ?? '').trim().toLowerCase()
  let requested: ModelTier = route.preferred
  let reason: RouteDecision['reason'] = 'preferred'
  if (isTier(override)) {
    requested = override
    reason = 'platform_override'
  } else if (isTier(orgTier) && orgTier !== route.preferred) {
    requested = orgTier
    reason = 'org_config'
  }
  if (RANK[requested] < RANK[route.minimum]) {
    requested = route.minimum
    reason = 'raised_to_minimum'
  }
  const order = [requested, ...route.fallbacks.filter((t) => t !== requested && RANK[t] >= RANK[route.minimum])]
  for (const tier of order) {
    const model = tierModel(tier, env)
    if (model) return { task, requested, effective: tier, model, fallback: tier !== requested, reason }
  }
  return { task, requested, effective: requested, model: null, fallback: false, reason: 'not_configured' }
}

/** Ambiente ridotto per il compito (stesse garanzie di envForTier, ma con il routing per compito). */
export function envForTask(task: AiTask, orgTier: ModelTier | null | undefined, env: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; choice: ModelChoice; route: RouteDecision } {
  const route = routeModel(task, orgTier, env)
  const prices = tierPrices(route.effective, env)
  const out: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    OPENAI_MODEL: route.model ?? '',
    LEADFLOW_INTERNAL_SECRET: env.LEADFLOW_INTERNAL_SECRET,
    OPENAI_PRICE_INPUT_PER_MTOK: prices ? String(prices.input) : '',
    OPENAI_PRICE_OUTPUT_PER_MTOK: prices ? String(prices.output) : '',
  }
  return { env: out, choice: { requested: route.requested, effective: route.effective, model: route.model, fallback: route.fallback }, route }
}

/** Limiti di output (token) per chiamata degli agenti: contengono il costo massimo di ogni operazione. */
export const AGENT_MAX_OUTPUT_TOKENS = { strategy: 3000 } as const
