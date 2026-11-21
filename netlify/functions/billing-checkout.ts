import { handleError, json } from './_shared/http'
import { billingAdminRequest, requirePlanCode } from './_shared/billing/endpoint'
import { billingDeps } from './_shared/billing/deps'
import { startCheckout } from './_shared/billing/service'

/**
 * POST /api/billing/checkout { organization_id, plan, return_to? ('billing' | 'onboarding') }
 * Admin dell'organizzazione → crea/recupera lo Stripe Customer e una Checkout Session
 * ospitata. L'abbonamento si attiva SOLO quando arriva il webhook firmato di Stripe.
 */
export default async (req: Request): Promise<Response> => {
  try {
    const { ctx, body } = await billingAdminRequest(req)
    const returnTo = body.return_to === 'onboarding' ? 'onboarding' : 'billing'
    return json(await startCheckout(billingDeps(), ctx, requirePlanCode(body.plan), returnTo))
  } catch (err) {
    return handleError(err)
  }
}
export const config = { path: '/api/billing/checkout' }
