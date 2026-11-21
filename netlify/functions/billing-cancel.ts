import { HttpError, handleError, json } from './_shared/http'
import { billingAdminRequest } from './_shared/billing/endpoint'
import { billingDeps } from './_shared/billing/deps'
import { setCancellation } from './_shared/billing/service'

/**
 * POST /api/billing/cancel { organization_id, action: 'cancel' | 'resume' } (solo admin).
 * La cancellazione avviene a fine periodo (accesso garantito fino alla scadenza pagata).
 */
export default async (req: Request): Promise<Response> => {
  try {
    const { ctx, body } = await billingAdminRequest(req)
    if (body.action !== 'cancel' && body.action !== 'resume') throw new HttpError(400, 'invalid_action')
    if (body.action === 'cancel' && body.confirm !== true) throw new HttpError(400, 'confirmation_required')
    return json(await setCancellation(billingDeps(), ctx, body.action))
  } catch (err) {
    return handleError(err)
  }
}
export const config = { path: '/api/billing/cancel' }
