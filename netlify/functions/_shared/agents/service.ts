import { HttpError } from '../http'
import { aiMissingConfig } from '../lead-finder/analysisService'
import type { SearchProviderId } from '../lead-finder/providers/registry'
import type { ProviderAdapter } from '../lead-finder/types'
import type { BillingGate, Feature } from '../billing/store'
import { profileMissing } from '../sales-agent/context'
import type { SalesStore } from '../sales-agent/store'
import { AGENTS } from './catalog'
import { chooseModel } from './models'
import { buildPlan, parseObjective, validateParams, type Availability, type Plan } from './planner'
import type { AgentStore } from './store'
import { AGENT_KEYS, type WorkflowTemplate } from './types'

/**
 * Servizio applicativo degli endpoint: disponibilità reale dei componenti, pianificazione e avvio.
 * Autenticazione, appartenenza all'organizzazione e feature flag sono verificati dagli endpoint PRIMA.
 */
export interface ServiceDeps {
  store: AgentStore
  sales: SalesStore
  registry: Record<SearchProviderId, ProviderAdapter>
  billing?: BillingGate
  env?: NodeJS.ProcessEnv
}

export interface Ctx {
  orgId: string
  userId: string
  isAdmin: boolean
}

const FEATURES: Feature[] = ['lead_finder', 'ai_analyzer', 'ai_sales_agent', 'crm_advanced']

export async function gatherAvailability(deps: ServiceDeps, ctx: Ctx): Promise<Availability & { models: Record<string, { model_configured: boolean; fallback: boolean }> }> {
  const env = deps.env ?? process.env
  const [agents, creditCosts, profile, decisions] = await Promise.all([
    deps.store.getAgentConfigs(ctx.orgId),
    deps.store.getCreditCosts(),
    deps.sales.getProfile(ctx.orgId),
    Promise.all(FEATURES.map(async (f) => [f, deps.billing ? (await deps.billing.canUseFeature(ctx.orgId, f)).allowed : true] as const)),
  ])
  const aiMissing = aiMissingConfig(env)
  const tiers = ['economy', 'standard', 'advanced'] as const
  return {
    providers: Object.values(deps.registry).map((p) => {
      const missing = p.missingConfig()
      // I nomi delle variabili mancanti sono mostrati solo agli amministratori.
      return { id: p.id, configured: missing.length === 0, canStore: p.license.canStoreContent, missing: ctx.isAdmin ? missing : [] }
    }),
    ai: { configured: aiMissing.length === 0, missing: ctx.isAdmin ? aiMissing : [] },
    features: Object.fromEntries(decisions),
    agents,
    creditCosts,
    salesProfileMissing: profileMissing(profile),
    models: Object.fromEntries(
      tiers.map((t) => {
        const c = chooseModel(t, env)
        return [t, { model_configured: !!c.model, fallback: c.fallback }]
      }),
    ),
  }
}

export async function planWorkflow(
  deps: ServiceDeps,
  ctx: Ctx,
  input: { template?: WorkflowTemplate; objective?: string; params?: Record<string, unknown> },
): Promise<{ interpretation: ReturnType<typeof parseObjective> | null; plan: Plan | null; invalid_fields?: string[] }> {
  const interpretation = input.objective ? parseObjective(input.objective) : null
  const template = input.template ?? interpretation?.template
  if (!template) throw new HttpError(400, 'template_required')
  const params = { ...(interpretation && interpretation.template === template ? interpretation.params : {}), ...(input.params ?? {}) }
  const v = validateParams(template, params)
  if (!v.ok) return { interpretation, plan: null, invalid_fields: v.fields }
  const av = await gatherAvailability(deps, ctx)
  return { interpretation, plan: buildPlan(template, v.params, av) }
}

export async function startWorkflow(
  deps: ServiceDeps,
  ctx: Ctx,
  input: { template: WorkflowTemplate; objective?: string; params: Record<string, unknown>; budget_credits: number; idempotency_key: string },
): Promise<{ workflow_id: string; created: boolean; status: string; plan: Plan }> {
  const v = validateParams(input.template, input.params)
  if (!v.ok) throw new HttpError(400, 'invalid_input', { fields: v.fields })
  const av = await gatherAvailability(deps, ctx)
  const plan = buildPlan(input.template, v.params, av)
  // Nessun avvio se manca un componente necessario: l'interfaccia mostra la configurazione da completare.
  if (plan.blocked) throw new HttpError(409, 'plan_blocked', { missing: plan.missing.map((m) => ({ ...m, env: ctx.isAdmin ? m.env : undefined })) })
  const orchestrator = av.agents.find((a) => a.agentKey === 'orchestrator')
  if (orchestrator?.maxCreditsPerRun !== null && orchestrator?.maxCreditsPerRun !== undefined && input.budget_credits > orchestrator.maxCreditsPerRun) {
    throw new HttpError(400, 'budget_above_limit', { limit: orchestrator.maxCreditsPerRun })
  }
  const res = await deps.store.createWorkflow({
    org: ctx.orgId,
    template: input.template,
    objective: input.objective?.trim() ? input.objective.trim().slice(0, 1000) : null,
    params: v.params,
    idempotencyKey: input.idempotency_key,
    budgetCredits: input.budget_credits,
    maxRuntimeSeconds: input.template === 'prospecting' ? 3600 : 900,
    createdBy: ctx.userId,
    steps: plan.steps,
  })
  return { workflow_id: res.workflow.id, created: res.created, status: res.workflow.status, plan }
}

/** Descrizione statica degli agenti (allowlist degli strumenti inclusa) per la console. */
export function agentCatalog() {
  return AGENT_KEYS.map((k) => ({ key: k, tools: AGENTS[k].tools, features: AGENTS[k].features, default_tier: AGENTS[k].defaultTier, uses_ai: AGENTS[k].usesAi }))
}
