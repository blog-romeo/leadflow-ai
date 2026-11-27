import { handleError, json, readJson, requireMethod } from './_shared/http'
import { authorize } from './_shared/demand-hunter/deps'
import { setFeedback } from './_shared/demand-hunter/services'
import { feedbackSchema, parseOr400 } from './_shared/demand-hunter/validation'

/** POST /api/demand-hunter/feedback — giudizio Giusto/Sbagliato su un lead (null lo rimuove). */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(feedbackSchema, await readJson(req, 2_000))
    const { ctx, deps } = await authorize(req, input.organization_id)
    return json(await setFeedback(deps, ctx, input.lead_id, input.verdict))
  } catch (err) {
    return handleError(err, '/api/demand-hunter/feedback')
  }
}

export const config = { path: '/api/demand-hunter/feedback' }
