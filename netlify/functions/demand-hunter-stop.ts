import { handleError, json, readJson, requireMethod } from './_shared/http'
import { authorize } from './_shared/demand-hunter/deps'
import { stop } from './_shared/demand-hunter/services'
import { jobRefSchema, parseOr400 } from './_shared/demand-hunter/validation'

/** POST /api/demand-hunter/stop — ferma una caccia in corso (quello che ha trovato resta). */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(jobRefSchema, await readJson(req, 2_000))
    const { ctx, deps } = await authorize(req, input.organization_id)
    return json(await stop(deps, ctx, input.job_id))
  } catch (err) {
    return handleError(err, '/api/demand-hunter/stop')
  }
}

export const config = { path: '/api/demand-hunter/stop' }
