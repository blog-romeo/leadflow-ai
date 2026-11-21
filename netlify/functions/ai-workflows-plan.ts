import { handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { parseOr400 } from './_shared/lead-finder/validation'
import { assertAgentsEnabled } from './_shared/agents/flags'
import { planInputSchema } from './_shared/agents/validation'
import { planWorkflow } from './_shared/agents/service'
import { agentServiceDeps } from './_shared/agents/deps'

/**
 * POST /api/ai-workflows/plan — interpreta l'obiettivo (regole deterministiche) e restituisce il piano:
 * passi, approvazioni richieste, stima massima dei crediti, configurazioni mancanti. Nessun effetto.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(planInputSchema, await readJson(req, 16_000))
    const { user, role } = await requireOrgMember(req, input.organization_id)
    assertAgentsEnabled(input.organization_id)
    const res = await planWorkflow(agentServiceDeps(), { orgId: input.organization_id, userId: user.id, isAdmin: role === 'organization_admin' }, input)
    return json(res)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/ai-workflows/plan' }
