import { handleError, json, requireMethod } from './_shared/http'
import { authorize } from './_shared/demand-hunter/deps'
import { status } from './_shared/demand-hunter/services'
import { orgSchema, parseOr400, queryParams } from './_shared/demand-hunter/validation'

/** GET /api/demand-hunter/status?organization_id= — servizio, modalità (simulata/reale), limiti e ultime sessioni. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET')
    const { organization_id } = parseOr400(orgSchema, queryParams(req))
    const { ctx, deps } = await authorize(req, organization_id)
    return json(await status(deps, ctx, deps.configMissing))
  } catch (err) {
    return handleError(err, '/api/demand-hunter/status')
  }
}

export const config = { path: '/api/demand-hunter/status' }
