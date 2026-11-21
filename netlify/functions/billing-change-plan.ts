import { handleError, json } from './_shared/http'
import { billingAdminRequest, requirePlanCode } from './_shared/billing/endpoint'
import { billingDeps } from './_shared/billing/deps'
import { changePlan } from './_shared/billing/service'

/**
 * POST /api/billing/change-plan { organization_id, plan } — upgrade o downgrade (solo admin).
 * Upgrade: differenza pro-rata fatturata subito (se il pagamento fallisce il cambio non si applica).
 * Downgrade: credito pro-rata sulla fattura successiva.
 */
export default async (req: Request): Promise<Response> => {
  try {
    const { ctx, body } = await billingAdminRequest(req)
    return json(await changePlan(billingDeps(), ctx, requirePlanCode(body.plan)))
  } catch (err) {
    return handleError(err)
  }
}
export const config = { path: '/api/billing/change-plan' }
