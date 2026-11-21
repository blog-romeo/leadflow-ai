import { handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { candidateIdsSchema, parseOr400 } from './_shared/lead-finder/validation'
import { saveToCrm } from './_shared/lead-finder/services'
import { leadFinderDeps, PROVIDER_LABELS } from './_shared/lead-finder/deps'
import { requireFeature } from './_shared/billing/access'
import { billingGate } from './_shared/billing/deps'

/** POST /api/lead-finder/save — salva nel CRM i candidati consentiti dalla licenza. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(candidateIdsSchema, await readJson(req, 16_000))
    const { user } = await requireOrgMember(req, input.organization_id)
    // Controllo di piano lato server (402 se la funzionalità non è inclusa o l'abbonamento non è attivo).
    await requireFeature(billingGate(), input.organization_id, 'lead_finder')
    const { store } = leadFinderDeps()
    return json(await saveToCrm({ store, providerLabels: PROVIDER_LABELS }, { orgId: input.organization_id, userId: user.id }, input.candidate_ids))
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/lead-finder/save' }
