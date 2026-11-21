import { handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { dispatchBackground } from './_shared/dispatch'
import { parseOr400 } from './_shared/lead-finder/validation'
import { log } from './_shared/log'
import { assertAgentsEnabled } from './_shared/agents/flags'
import { startInputSchema } from './_shared/agents/validation'
import { startWorkflow } from './_shared/agents/service'
import { agentServiceDeps } from './_shared/agents/deps'

/**
 * POST /api/ai-workflows/start — crea il workflow (idempotente per idempotency_key) e avvia l'esecuzione
 * in una background function. Restituisce 202. Nessun invio di comunicazioni: le operazioni ad alto
 * impatto si fermano in attesa di approvazione.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(startInputSchema, await readJson(req, 32_000))
    const { user, role } = await requireOrgMember(req, input.organization_id)
    assertAgentsEnabled(input.organization_id)
    const res = await startWorkflow(agentServiceDeps(), { orgId: input.organization_id, userId: user.id, isAdmin: role === 'organization_admin' }, input)
    let dispatched = false
    if (res.created || res.status === 'pending') {
      dispatched = await dispatchBackground('/api/ai-workflows/run', req.url, { workflow_id: res.workflow_id })
      // Se l'avvio non riesce, il workflow resta "pending" e viene ripreso dalla function pianificata.
      if (!dispatched) log('warn', 'ai_workflow.dispatch_deferred', { workflow_id: res.workflow_id })
    }
    return json({ workflow_id: res.workflow_id, created: res.created, status: res.status, dispatched, approvals: res.plan.approvals, estimate: res.plan.estimate }, 202)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/ai-workflows/start' }
