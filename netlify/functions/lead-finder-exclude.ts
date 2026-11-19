import { handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { exclusionSchema, parseOr400 } from './_shared/lead-finder/validation'
import { setExclusion } from './_shared/lead-finder/services'
import { leadFinderDeps } from './_shared/lead-finder/deps'

/** POST /api/lead-finder/exclude — esclude (o ripristina) candidati dalle ricerche future. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(exclusionSchema, await readJson(req, 16_000))
    const { user } = await requireOrgMember(req, input.organization_id)
    const { store } = leadFinderDeps()
    return json(await setExclusion({ store }, { orgId: input.organization_id, userId: user.id }, input.candidate_ids, input.excluded, input.reason))
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/lead-finder/exclude' }
