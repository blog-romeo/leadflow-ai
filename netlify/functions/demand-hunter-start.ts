import { handleError, json, readJson, requireMethod } from './_shared/http'
import { authorize } from './_shared/demand-hunter/deps'
import { start } from './_shared/demand-hunter/services'
import { parseOr400, startSchema } from './_shared/demand-hunter/validation'

/** POST /api/demand-hunter/start — avvia la caccia o l'espansione SOLO con il token confermato (monouso). */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(startSchema, await readJson(req, 4_000))
    const { ctx, deps } = await authorize(req, input.organization_id)
    return json(await start(deps, ctx, input))
  } catch (err) {
    return handleError(err, '/api/demand-hunter/start')
  }
}

export const config = { path: '/api/demand-hunter/start' }
