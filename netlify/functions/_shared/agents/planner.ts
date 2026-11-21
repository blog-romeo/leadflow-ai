import type { Feature } from '../billing/store'
import { matchSector } from '../lead-finder/sectors'
import { AGENTS } from './catalog'
import type { WorkflowCreate } from './store'
import type { AgentConfig, AgentKey, StepAction, WorkflowTemplate } from './types'
import { PARAM_SCHEMAS, type FollowUpParams, type ProspectingParams } from './validation'

/**
 * Pianificazione DETERMINISTICA dei workflow.
 *
 * L'obiettivo scritto dall'utente è interpretato con regole (non da un modello): i parametri risultanti
 * sono mostrati all'utente, validati e limitati. Così un testo malevolo non può far comparire passi,
 * strumenti o agenti non previsti: i passi possibili sono solo quelli dei modelli qui sotto.
 */
export interface ParsedObjective {
  template: WorkflowTemplate
  params: Record<string, unknown>
  recognized: string[]
  warnings: string[]
}

const ADJECTIVE_SECTORS: [RegExp, string][] = [
  [/\balberghier[oaie]\b|\bricettiv[oaie]\b|\bhotellerie\b/, 'hotel'],
  [/\bristorazione\b/, 'ristorante'],
  [/\bimmobiliar[eio]\b/, 'agenzia immobiliare'],
  [/\bodontoiatric[oaie]\b|\bdentistic[oaie]\b/, 'dentista'],
  [/\bautomotive\b|\bautomobilistic[oaie]\b/, 'concessionaria auto'],
  [/\bedil[eiz]\w*\b/, 'impresa edile'],
]

export function parseObjective(raw: string): ParsedObjective {
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 1000)
  const t = text.toLowerCase()
  const recognized: string[] = []
  const warnings: string[] = []

  if (/follow.?up|trattativ\w* ferm\w*|opportunit\w* ferm\w*|promemoria|stalled|stale deals|senza aggiornament/.test(t)) {
    return { template: 'follow_up_review', params: {}, recognized: ['template'], warnings }
  }
  if (/prestazioni|performance|andamento|metriche|kpi|crescita commerciale|growth|analizza i risultati|risultati commerciali/.test(t) && !/\btrova\b|\bcerca\b|\bfind\b/.test(t)) {
    const m = t.match(/(?:ultimi|last)\s+(\d{1,3})\s+(?:giorni|days)/)
    const params: Record<string, unknown> = {}
    if (m) {
      params.period_days = Math.min(Math.max(Number(m[1]), 7), 365)
      recognized.push('period_days')
    }
    return { template: 'growth_report', params, recognized: ['template', ...recognized], warnings }
  }

  const params: Record<string, unknown> = {}
  const count = t.match(/(\d{1,4})\s+(?:aziende|imprese|attivit[aà]|lead|potenziali clienti|companies|businesses|hotel\w*|ristoranti|negozi|studi)\b/)
  if (count) {
    const n = Number(count[1])
    params.max_results = Math.min(Math.max(n, 1), 50)
    if (n > 50) warnings.push('max_results_capped')
    recognized.push('max_results')
  }
  const top = t.match(/(?:le|i|gli|per le|per i|the|top)\s*(\d{1,3})\s+(?:pi[uù] compatibili|migliori|pi[uù] promettenti|most compatible|best)/) ?? t.match(/\btop\s*(\d{1,3})\b/)
  const wantsProposal = /propost|strategi|proposal|pitch|offerta commerciale/.test(t)
  if (wantsProposal) {
    const n = top ? Number(top[1]) : 5
    params.proposals_top = Math.min(Math.max(n, 1), 20)
    if (n > 20) warnings.push('proposals_top_capped')
    recognized.push('proposals_top')
  }
  const max = (params.max_results as number | undefined) ?? 30
  if (/analizz|analy[sz]e|ricerca approfondita|research/.test(t)) {
    params.analyze_top = max
    recognized.push('analyze_top')
  } else {
    params.analyze_top = Math.min((params.proposals_top as number | undefined) ?? 0, max)
  }
  if (typeof params.proposals_top === 'number' && params.proposals_top > max) params.proposals_top = max

  // Settore: "nel settore X", aggettivi comuni, oppure una parola riconosciuta dal registro dei settori.
  let sector: string | null = null
  for (const [re, s] of ADJECTIVE_SECTORS) if (re.test(t)) sector = s
  if (!sector) {
    const m = t.match(/settore\s+(?:del(?:l[ae'’]\s?)?|dei|degli|delle)?\s*([a-zà-ü&' ]{3,40}?)(?:\s+(?:a|in|di|nella|nel|,)\b|[,.]|$)/)
    if (m && matchSector(m[1]!.trim())) sector = m[1]!.trim()
  }
  if (!sector) {
    for (const w of t.split(/[^a-zà-ü&]+/).filter((x) => x.length >= 3)) {
      if (matchSector(w)) {
        sector = w
        break
      }
    }
  }
  if (sector) {
    params.sector = sector
    recognized.push('sector')
  }
  // Località: "a Roma", "in Lombardia" (parola con iniziale maiuscola nel testo originale).
  const loc = text.match(/\b(?:a|in|ad|nella provincia di|near|in the city of)\s+([A-ZÀ-Ü][A-Za-zÀ-ü'’.-]+(?:\s+[A-ZÀ-Ü][A-Za-zÀ-ü'’.-]+){0,2})/)
  if (loc) {
    params.location = loc[1]!.replace(/[.,]+$/, '')
    recognized.push('location')
  }
  params.country = 'IT'
  return { template: 'prospecting', params, recognized: ['template', ...recognized], warnings }
}

// ════════════════════════════════════════════════════════════════════════════
// Piano: passi, approvazioni, stima dei crediti, configurazioni mancanti
// ════════════════════════════════════════════════════════════════════════════
export interface Availability {
  providers: { id: string; configured: boolean; canStore: boolean; missing: string[] }[]
  ai: { configured: boolean; missing: string[] }
  features: Partial<Record<Feature, boolean>>
  agents: AgentConfig[]
  creditCosts: Record<string, number>
  salesProfileMissing: string[]
}

export interface PlanIssue {
  code: string
  component: AgentKey | 'platform'
  /** Variabili d'ambiente mancanti (mostrate solo agli amministratori dall'endpoint). */
  env?: string[]
  feature?: string
  fields?: string[]
}

export interface Plan {
  template: WorkflowTemplate
  params: Record<string, unknown>
  steps: WorkflowCreate['steps']
  approvals: string[]
  estimate: { max_credits: number; by_agent: Partial<Record<AgentKey, number>>; note: string }
  missing: PlanIssue[]
  warnings: string[]
  blocked: boolean
}

type StepDef = WorkflowCreate['steps'][number]
const step = (position: number, agentKey: AgentKey, action: StepAction, dependsOn: number[], extra: Partial<StepDef> = {}): StepDef => ({
  position,
  agentKey,
  action,
  dependsOn,
  requiresApproval: false,
  maxAttempts: 2,
  timeoutSeconds: 600,
  input: {},
  ...extra,
})

export function validateParams(template: WorkflowTemplate, params: unknown): { ok: true; params: Record<string, unknown> } | { ok: false; fields: string[] } {
  const r = PARAM_SCHEMAS[template].safeParse(params ?? {})
  if (!r.success) return { ok: false, fields: r.error.issues.slice(0, 8).map((i) => i.path.join('.') || '(root)') }
  return { ok: true, params: r.data as Record<string, unknown> }
}

export function buildPlan(template: WorkflowTemplate, params: Record<string, unknown>, av: Availability): Plan {
  const missing: PlanIssue[] = []
  const warnings: string[] = []
  const steps: StepDef[] = []
  const byAgent: Partial<Record<AgentKey, number>> = {}
  const credit = (task: string) => av.creditCosts[task] ?? 0
  const agentOn = (k: AgentKey) => av.agents.find((a) => a.agentKey === k)?.enabled ?? true

  const need = (k: AgentKey) => {
    if (!agentOn(k)) missing.push({ code: 'agent_disabled', component: k })
    for (const f of AGENTS[k].features) if (av.features[f] === false) missing.push({ code: 'billing_feature_not_in_plan', component: k, feature: f })
  }
  const needAi = (k: AgentKey) => {
    if (!av.ai.configured) missing.push({ code: 'ai_not_configured', component: k, env: av.ai.missing })
  }

  if (template === 'prospecting') {
    const p = params as ProspectingParams
    need('discovery')
    const usable = av.providers.filter((x) => x.configured && x.canStore && (p.provider === 'auto' || x.id === p.provider))
    if (!usable.length) {
      const relevant = av.providers.filter((x) => x.canStore && (p.provider === 'auto' || x.id === p.provider))
      missing.push({ code: 'provider_not_configured', component: 'discovery', env: [...new Set(relevant.flatMap((x) => x.missing))] })
    }
    if (p.company_size !== 'any') warnings.push('filter_unsupported_company_size')
    steps.push(step(1, 'discovery', 'discover', [], { timeoutSeconds: 180 }))
    if (p.analyze_top > 0) {
      need('research')
      needAi('research')
      byAgent.research = p.analyze_top * credit('business_analysis')
      steps.push(step(2, 'research', 'research', [1], { timeoutSeconds: 1800 }))
    }
    need('scoring')
    steps.push(step(3, 'scoring', 'score', [1], { timeoutSeconds: 120 }))
    if (p.proposals_top > 0) {
      need('strategy')
      needAi('strategy')
      if (av.salesProfileMissing.length) missing.push({ code: 'sales_profile_incomplete', component: 'strategy', fields: av.salesProfileMissing })
      if (p.analyze_top === 0) warnings.push('strategy_without_research')
      byAgent.strategy = p.proposals_top * credit('sales_strategy')
      steps.push(step(4, 'orchestrator', 'crm.save_leads', [3], { requiresApproval: true, maxAttempts: 1, timeoutSeconds: 300 }))
      steps.push(step(5, 'strategy', 'strategy', [4], { timeoutSeconds: 1800 }))
    }
  } else if (template === 'follow_up_review') {
    const p = params as FollowUpParams
    need('follow_up')
    steps.push(step(1, 'follow_up', 'follow_up.analyze', [], { timeoutSeconds: 120 }))
    steps.push(step(2, 'follow_up', 'follow_up.apply', [1], { requiresApproval: true, maxAttempts: 1, timeoutSeconds: 900 }))
    if (p.prepare_drafts && p.drafts_max > 0) {
      needAi('follow_up')
      byAgent.follow_up = p.drafts_max * credit('follow_up_suggestion')
    }
  } else {
    need('growth_analyst')
    steps.push(step(1, 'growth_analyst', 'growth.analyze', [], { timeoutSeconds: 120 }))
  }

  const approvals = steps.filter((s) => s.requiresApproval).map((s) => s.action)
  const maxCredits = Object.values(byAgent).reduce((a, b) => a + (b ?? 0), 0)
  return {
    template,
    params,
    steps,
    approvals,
    estimate: { max_credits: maxCredits, by_agent: byAgent, note: 'upper_bound_cache_may_reduce' },
    missing,
    warnings,
    blocked: missing.length > 0,
  }
}
