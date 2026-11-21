import { handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { parseOr400, searchInputSchema } from './_shared/lead-finder/validation'
import { runSearch } from './_shared/lead-finder/services'
import { leadFinderDeps } from './_shared/lead-finder/deps'
import { requireFeature } from './_shared/billing/access'
import { billingGate } from './_shared/billing/deps'

/** POST /api/lead-finder/search — ricerca su un provider autorizzato. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(searchInputSchema, await readJson(req, 16_000))
    const { user } = await requireOrgMember(req, input.organization_id)
    // Controllo di piano lato server (402 se la funzionalità non è inclusa o l'abbonamento non è attivo).
    await requireFeature(billingGate(), input.organization_id, 'lead_finder')
    const result = await runSearch(leadFinderDeps(), { orgId: input.organization_id, userId: user.id }, input)
    return json(result)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/lead-finder/search' }
