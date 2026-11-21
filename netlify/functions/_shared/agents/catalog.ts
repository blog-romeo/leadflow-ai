import type { Feature } from '../billing/store'
import type { AgentKey, ModelTier } from './types'

/**
 * Catalogo degli agenti: strumenti consentiti (allowlist), funzionalità di piano richieste e livello di
 * modello predefinito. Il catalogo vive nel CODICE e non nel database: né gli utenti né gli agenti possono
 * ampliare gli strumenti di un agente. La configurazione per organizzazione (ai_agents) può solo
 * disattivare un agente, cambiarne il livello di modello o ridurne il budget.
 */
export type ToolName =
  | 'provider.search'
  | 'candidates.read'
  | 'ai.analyze_company'
  | 'evidence.write'
  | 'profile.read'
  | 'crm.history.read'
  | 'scores.write'
  | 'leads.read'
  | 'memory.read'
  | 'evidence.read'
  | 'ai.generate_strategy'
  | 'drafts.write'
  | 'crm.read'
  | 'followups.create'
  | 'followups.block'
  | 'ai.follow_up_suggestion'
  | 'metrics.read'
  | 'crm.save_leads'

export interface AgentDefinition {
  key: AgentKey
  tools: readonly ToolName[]
  /** Funzionalità del piano richieste (verificate lato server prima di avviare il workflow). */
  features: readonly Feature[]
  defaultTier: ModelTier
  usesAi: boolean
  /** Compito AI registrato in ai_jobs (prenota i crediti tramite i trigger di billing). */
  aiTask: 'business_analysis' | 'sales_strategy' | 'follow_up_suggestion' | null
}

export const AGENTS: Record<AgentKey, AgentDefinition> = {
  orchestrator: { key: 'orchestrator', tools: ['crm.save_leads', 'candidates.read'], features: [], defaultTier: 'standard', usesAi: false, aiTask: null },
  discovery: { key: 'discovery', tools: ['provider.search', 'candidates.read'], features: ['lead_finder'], defaultTier: 'standard', usesAi: false, aiTask: null },
  // Estrazione strutturata dal sito: compito semplice → modello economico se configurato.
  research: { key: 'research', tools: ['candidates.read', 'ai.analyze_company', 'evidence.write'], features: ['ai_analyzer'], defaultTier: 'economy', usesAi: true, aiTask: 'business_analysis' },
  scoring: { key: 'scoring', tools: ['candidates.read', 'profile.read', 'crm.history.read', 'scores.write', 'leads.read'], features: ['lead_finder'], defaultTier: 'standard', usesAi: false, aiTask: null },
  // Ragionamento commerciale: modello avanzato solo se configurato, altrimenti quello standard.
  strategy: { key: 'strategy', tools: ['leads.read', 'profile.read', 'memory.read', 'evidence.read', 'ai.generate_strategy', 'drafts.write'], features: ['ai_sales_agent'], defaultTier: 'advanced', usesAi: true, aiTask: 'sales_strategy' },
  follow_up: { key: 'follow_up', tools: ['crm.read', 'followups.create', 'followups.block', 'ai.follow_up_suggestion', 'drafts.write'], features: ['ai_sales_agent'], defaultTier: 'economy', usesAi: true, aiTask: 'follow_up_suggestion' },
  growth_analyst: { key: 'growth_analyst', tools: ['metrics.read'], features: ['crm_advanced'], defaultTier: 'standard', usesAi: false, aiTask: null },
}

/** Operazioni ad alto impatto: eseguibili solo con un'approvazione esplicita registrata nel database. */
export const HIGH_IMPACT_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['crm.save_leads', 'followups.create', 'followups.block'])

/**
 * Strumenti che NESSUN agente può avere: il gateway li rifiuta anche se comparissero in un'allowlist.
 * (Lettura di segreti, ruoli, pagamenti, invii, cancellazioni massive, accesso ad altre organizzazioni.)
 */
export const FORBIDDEN_TOOL_PATTERNS: readonly RegExp[] = [
  /^(secrets?|env|credentials?|api_keys?)\./,
  /^(roles?|members?|permissions?|auth)\./,
  /^(billing|payments?|stripe|prices?|plans?|subscriptions?)\./,
  /^(messages?|emails?|campaigns?|sms|whatsapp)\.(send|activate|schedule|launch)/,
  /\.(bulk_delete|delete_all|purge|truncate)$/,
  /^(org|organizations?|tenants?)\./,
  /^agents?\.(configure|update|grant)/,
  // Prompt 12: nessun agente modifica configurazioni, impostazioni di sicurezza, flag o il proprio training.
  /^(configs?|ai_configs?|settings|security|feature_flags?|flags?|training|benchmarks?|feedback)\./,
]

export function isForbiddenTool(tool: string): boolean {
  return FORBIDDEN_TOOL_PATTERNS.some((re) => re.test(tool))
}

export const MAX_TOOL_CALLS_PER_RUN = 400
