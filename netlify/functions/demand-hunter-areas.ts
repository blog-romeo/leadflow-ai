import { handleError, json, requireMethod } from './_shared/http'
import { authorize } from './_shared/demand-hunter/deps'
import { areasTree, suggestions } from './_shared/demand-hunter/services'
import { orgGoalSchema, parseOr400, queryParams } from './_shared/demand-hunter/validation'

/** GET /api/demand-hunter/areas?organization_id=&goal= — albero delle aree commerciali e oggetti suggeriti (gratis). */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET')
    const { organization_id, goal } = parseOr400(orgGoalSchema, queryParams(req))
    const { ctx, deps } = await authorize(req, organization_id)
    const [tree, sugg] = await Promise.all([areasTree(deps, ctx, goal), goal === 'clienti' ? suggestions(deps, ctx) : Promise.resolve({ suggestions: [] })])
    return json({ ...tree, suggestions: sugg.suggestions })
  } catch (err) {
    return handleError(err, '/api/demand-hunter/areas')
  }
}

export const config = { path: '/api/demand-hunter/areas' }
