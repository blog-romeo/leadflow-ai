import { handleError, json, requireMethod } from './_shared/http'
import { authorize } from './_shared/demand-hunter/deps'
import { jobView } from './_shared/demand-hunter/services'
import { jobRefSchema, parseOr400, queryParams } from './_shared/demand-hunter/validation'

/** GET /api/demand-hunter/job?organization_id=&job_id= — avanzamento in diretta, combinazioni, lead e prove. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET')
    const { organization_id, job_id } = parseOr400(jobRefSchema, queryParams(req))
    const { ctx, deps } = await authorize(req, organization_id)
    return json(await jobView(deps, ctx, job_id))
  } catch (err) {
    return handleError(err, '/api/demand-hunter/job')
  }
}

export const config = { path: '/api/demand-hunter/job' }
