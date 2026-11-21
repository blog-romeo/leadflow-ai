import { handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { parseOr400 } from './_shared/lead-finder/validation'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { createSupabaseStore } from './_shared/lead-finder/supabaseStore'
import { createSalesStore } from './_shared/sales-agent/supabaseStore'
import { requireFeature } from './_shared/billing/access'
import { billingGate } from './_shared/billing/deps'
import { assertAgentsEnabled } from './_shared/agents/flags'
import { rescoreInputSchema } from './_shared/agents/validation'
import { rescore } from './_shared/agents/handlers/scoring'
import { createAgentStore } from './_shared/agents/supabaseStore'

/**
 * POST /api/ai-agents/rescore — ricalcolo del punteggio di compatibilità quando cambiano le informazioni
 * (candidati e lead indicati). Deterministico: nessun credito AI.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(rescoreInputSchema, await readJson(req, 16_000))
    const { user } = await requireOrgMember(req, input.organization_id)
    assertAgentsEnabled(input.organization_id)
    await requireFeature(billingGate(), input.organization_id, 'lead_finder')
    const db = supabaseAdmin()
    const store = createAgentStore(db)
    const scoringCfg = (await store.getAgentConfigs(input.organization_id)).find((c) => c.agentKey === 'scoring')
    if (scoringCfg && !scoringCfg.enabled) return json({ error: 'agent_disabled' }, 409)
    const res = await rescore({ leadFinder: createSupabaseStore(db), sales: createSalesStore(db), store }, { orgId: input.organization_id, config: scoringCfg?.config ?? {} }, input)
    await store.audit(input.organization_id, user.id, 'ai_agent.rescored', 'organization', input.organization_id, { updated: res.updated })
    return json(res)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/ai-agents/rescore' }
