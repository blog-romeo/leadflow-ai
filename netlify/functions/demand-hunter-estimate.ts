import { handleError, json, readJson, requireMethod } from './_shared/http'
import { authorize } from './_shared/demand-hunter/deps'
import { estimate } from './_shared/demand-hunter/services'
import { estimateSchema, parseOr400 } from './_shared/demand-hunter/validation'

/** POST /api/demand-hunter/estimate — stima gratuita e token di conferma monouso (10 minuti). */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(estimateSchema, await readJson(req, 4_000))
    const { ctx, deps } = await authorize(req, input.organization_id)
    return json(await estimate(deps, ctx, input))
  } catch (err) {
    return handleError(err, '/api/demand-hunter/estimate')
  }
}

export const config = { path: '/api/demand-hunter/estimate' }
