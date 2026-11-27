import { z } from 'zod'
import { HIGH_IMPACT_TOOLS, isForbiddenTool, type ToolName } from '../agents/catalog'
import { HttpError } from '../http'
import type { UsageSummary } from './store'
import type { DhMode, Goal, Reading, ServiceLead, ServiceSnapshot, Verdict } from './types'

/**
 * Agenti del Demand Hunter.
 *
 * Non sono un secondo motore multi-agent: seguono le stesse regole del catalogo esistente
 * (_shared/agents/catalog.ts) — strumenti in allowlist definiti nel CODICE, strumenti vietati rifiutati,
 * operazioni ad alto impatto (crm.save_leads) solo con un'azione esplicita dell'utente — e si scambiano
 * output strutturati validati con zod (come envelope.ts). Il loro lavoro è deterministico: la logica è
 * quella originale di BuyerML eseguita dal servizio Python (nessun modello AI viene chiamato qui).
 *
 *   orchestrator        coordina i passi, applica budget e limiti dell'organizzazione prima di ogni spesa
 *   market_discovery    albero delle aree e scoperta di concetti (areas.py) — a pagamento solo l'espansione
 *   demand_hunter       la caccia: combinazioni verbo × oggetto su Google via SerpApi (hunt.py)
 *   intent_analysis     lettura di ogni post: chi scrive, intenzioni, stadio, prove testuali (demand.py)
 *   lead_qualification  priorità, esclusione dei giudizi "sbagliato", passaggio al CRM con deduplicazione;
 *                       nel CRM il lead prosegue con gli agenti esistenti (scoring, strategy, follow_up)
 *   learning            feedback Giusto/Sbagliato e tassi per verbo, oggetto e schema (learning.py)
 */
export type DemandAgentKey = 'orchestrator' | 'market_discovery' | 'demand_hunter' | 'intent_analysis' | 'lead_qualification' | 'learning'

export type DemandToolName =
  | 'dh.limits.read'
  | 'dh.confirmations.consume'
  | 'service.areas.read'
  | 'service.areas.plan'
  | 'service.areas.expand'
  | 'service.hunt.plan'
  | 'service.hunt.start'
  | 'service.hunt.read'
  | 'service.hunt.stop'
  | 'service.classify'
  | 'service.learning.read'
  | 'service.learning.feedback'
  | 'dh.leads.write'
  | 'dh.feedback.write'
  | Extract<ToolName, 'crm.save_leads'>

export interface DemandAgentDefinition {
  key: DemandAgentKey
  tools: readonly DemandToolName[]
  /** true se l'agente può causare chiamate a pagamento (sempre dopo conferma e prenotazione). */
  paid: boolean
  /** Agente esistente che riceve il risultato, se c'è (nessuna duplicazione di funzioni). */
  handsOffTo?: string
}

export const DEMAND_AGENTS: Record<DemandAgentKey, DemandAgentDefinition> = {
  orchestrator: { key: 'orchestrator', tools: ['dh.limits.read', 'dh.confirmations.consume'], paid: false },
  market_discovery: { key: 'market_discovery', tools: ['service.areas.read', 'service.areas.plan', 'service.areas.expand'], paid: true },
  demand_hunter: { key: 'demand_hunter', tools: ['service.hunt.plan', 'service.hunt.start', 'service.hunt.read', 'service.hunt.stop', 'dh.leads.write'], paid: true },
  intent_analysis: { key: 'intent_analysis', tools: ['service.classify'], paid: false },
  lead_qualification: { key: 'lead_qualification', tools: ['crm.save_leads'], paid: false, handsOffTo: 'scoring' },
  learning: { key: 'learning', tools: ['service.learning.read', 'service.learning.feedback', 'dh.feedback.write'], paid: false },
}

/** Rifiuta uno strumento non in allowlist o vietato dal catalogo globale. */
export function assertTool(agent: DemandAgentKey, tool: DemandToolName): void {
  if (isForbiddenTool(tool) || !DEMAND_AGENTS[agent].tools.includes(tool)) throw new HttpError(403, 'agent_tool_not_allowed', { agent, tool })
}

/** crm.save_leads è ad alto impatto: richiede un'azione esplicita dell'utente (selezione + pulsante). */
export function requiresExplicitApproval(tool: DemandToolName): boolean {
  return HIGH_IMPACT_TOOLS.has(tool as ToolName)
}

// ─── Output strutturati condivisi tra gli agenti ─────────────────────────────
const evidence = z.object({ signal: z.string().nullable(), match: z.string().nullable() })
export const readingSchema = z
  .object({
    author_role: z.string(),
    demand: z.string(),
    intent_types: z.array(z.string()),
    stage: z.string(),
    lead_score: z.number().int().min(0).max(100),
    confidence: z.number().min(0).max(1),
    urgency: z.string(),
    budget_declared: z.boolean(),
    specificity: z.string(),
    lead_class: z.string(),
    taxonomy_path: z.array(z.string()),
    technology: z.array(z.string()),
    evidence: z.array(evidence).max(50),
    reader: z.string(),
  })
  .passthrough()

const serviceLeadSchema = z
  .object({
    url: z.string().regex(/^https?:\/\//).max(2000),
    text: z.string().min(1).max(5000),
    score: z.number().int().min(0).max(100),
    stage: z.string(),
    demand: z.string(),
    lead_class: z.string(),
    query: z.string().max(400),
    verb: z.string().max(80),
    object: z.string().max(200),
    technology: z.array(z.string()),
    node: z.string().nullable(),
    // La lettura è validata dall'Intent Analysis Agent: una lettura malformata scarta solo quella, non lo snapshot.
    reading: z.unknown().optional(),
  })
  .passthrough()

export const huntOutputSchema = z
  .object({
    status: z.string(),
    budget: z.number().int().min(1).max(500),
    spent: z.object({ searches: z.number().int().min(0), autocomplete: z.number().int().min(0) }),
    combos: z.number().int().min(0),
    lead_list: z.array(serviceLeadSchema).max(2000),
    combos_list: z.array(z.object({ query: z.string().max(400), verb: z.string(), object: z.string(), origin: z.string(), status: z.enum(['da provare', 'provata', 'già fatta', 'abbandonata']), results: z.number(), leads: z.number(), priority: z.number() }).passthrough()).max(2000),
    events: z.array(z.object({ at: z.string(), kind: z.string(), text: z.string() }).passthrough()).max(500),
  })
  .passthrough()

export interface Envelope<T> {
  agent: DemandAgentKey
  version: 1
  output: T
}

export interface QualifiedLead {
  url: string
  score: number
  priority: 'high' | 'medium' | 'low'
  qualified: boolean
  reasons: string[]
}

const GOAL_CLASSES: Record<Goal, string[]> = { clienti: ['cliente'], lavoro: ['lavoro_it', 'lavoro'] }

export function priorityOf(score: number): 'high' | 'medium' | 'low' {
  return score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low'
}

/** Demand Hunter Agent: valida lo snapshot del servizio (nessun campo non previsto passa agli altri agenti). */
export function demandHunterAgent(snapshot: unknown): Envelope<ServiceSnapshot> {
  const r = huntOutputSchema.safeParse(snapshot)
  if (!r.success) throw new HttpError(502, 'invalid_agent_output', { agent: 'demand_hunter' })
  // Spesa mai oltre il budget confermato (difesa in profondità: il servizio applica già il limite).
  if (r.data.spent.searches + r.data.spent.autocomplete > r.data.budget) throw new HttpError(502, 'invalid_agent_output', { agent: 'demand_hunter', reason: 'over_budget' })
  return { agent: 'demand_hunter', version: 1, output: r.data as unknown as ServiceSnapshot }
}

/** Intent Analysis Agent: ogni lead ha la sua lettura con prove testuali; un lead senza lettura valida è scartato. */
export function intentAnalysisAgent(leads: ServiceLead[]): Envelope<{ url: string; reading: Reading }[]> {
  const out: { url: string; reading: Reading }[] = []
  for (const l of leads) {
    const r = readingSchema.safeParse(l.reading)
    if (r.success) out.push({ url: l.url, reading: r.data as Reading })
  }
  return { agent: 'intent_analysis', version: 1, output: out }
}

/** Lead Qualification Agent: priorità e motivazioni; i giudizi "sbagliato" dell'utente prevalgono sulle regole. */
export function leadQualificationAgent(goal: Goal, leads: { url: string; score: number; reading: Reading | null; verdict: Verdict | null }[]): Envelope<QualifiedLead[]> {
  const ranked = leads.map((l) => {
    const reasons: string[] = []
    let qualified = true
    if (l.verdict === 'sbagliato') {
      qualified = false
      reasons.push('marked_wrong')
    }
    if (l.reading && !GOAL_CLASSES[goal].includes(l.reading.lead_class)) {
      qualified = false
      reasons.push('not_goal_class')
    }
    if (goal === 'clienti' && l.reading && l.reading.author_role !== 'buyer') {
      qualified = false
      reasons.push('not_buyer')
    }
    if (l.verdict === 'giusto') reasons.push('confirmed')
    if (l.reading?.budget_declared) reasons.push('budget_declared')
    if (l.reading?.urgency === 'high') reasons.push('urgent')
    return { url: l.url, score: l.score, priority: priorityOf(l.score), qualified, reasons }
  })
  ranked.sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.score - a.score)
  return { agent: 'lead_qualification', version: 1, output: ranked }
}

/** Orchestrator: nessuna spesa oltre i limiti dell'organizzazione (controllo prima della conferma). */
export function orchestratorBudgetCheck(usage: UsageSummary, paidCalls: number, mode: DhMode): { allowed: true } | { allowed: false; reason: 'disabled' | 'budget_per_hunt' | 'monthly_limit' } {
  if (!usage.enabled) return { allowed: false, reason: 'disabled' }
  if (paidCalls > usage.max_budget_per_hunt) return { allowed: false, reason: 'budget_per_hunt' }
  // Le chiamate simulate non costano e non consumano il limite mensile (resta il massimo per caccia).
  if (mode === 'live' && paidCalls > usage.remaining) return { allowed: false, reason: 'monthly_limit' }
  return { allowed: true }
}
