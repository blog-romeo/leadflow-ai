import { handleError, json, requireMethod } from './_shared/http'
import { authorize } from './_shared/demand-hunter/deps'
import { learning } from './_shared/demand-hunter/services'
import { orgGoalSchema, parseOr400, queryParams } from './_shared/demand-hunter/validation'

/** GET /api/demand-hunter/learning?organization_id=&goal= — tassi di lead per verbo, oggetto e schema. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET')
    const { organization_id, goal } = parseOr400(orgGoalSchema, queryParams(req))
    const { ctx, deps } = await authorize(req, organization_id)
    return json(await learning(deps, ctx, goal))
  } catch (err) {
    return handleError(err, '/api/demand-hunter/learning')
  }
}

export const config = { path: '/api/demand-hunter/learning' }
