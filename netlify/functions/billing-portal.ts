import { handleError, json } from './_shared/http'
import { billingAdminRequest } from './_shared/billing/endpoint'
import { billingDeps } from './_shared/billing/deps'
import { openPortal } from './_shared/billing/service'

/** POST /api/billing/portal { organization_id } — sessione Stripe Customer Portal (solo admin). */
export default async (req: Request): Promise<Response> => {
  try {
    const { ctx } = await billingAdminRequest(req)
    return json(await openPortal(billingDeps(), ctx))
  } catch (err) {
    return handleError(err)
  }
}
export const config = { path: '/api/billing/portal' }
