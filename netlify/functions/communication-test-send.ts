import { handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { parseOr400 } from './_shared/lead-finder/validation'
import { testSendSchema } from './_shared/campaigns/validation'
import { testSend } from './_shared/campaigns/accounts'
import { campaignDeps } from './_shared/campaigns/deps'
import { requireFeature } from './_shared/billing/access'
import { billingGate } from './_shared/billing/deps'

/**
 * POST /api/communication/test-send — invio di prova autorizzato (solo admin) verso un
 * indirizzo sandbox del provider o verso un membro dell'organizzazione.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(testSendSchema, await readJson(req, 8_000))
    const { user } = await requireOrgMember(req, input.organization_id, { admin: true })
    // Controllo di piano lato server (402 se la funzionalità non è inclusa o l'abbonamento non è attivo).
    await requireFeature(billingGate(), input.organization_id, 'campaign_manager')
    const deps = campaignDeps()
    const r = await testSend({ ...deps, worker: {} }, { orgId: input.organization_id, userId: user.id }, input)
    return json(r)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/communication/test-send' }
