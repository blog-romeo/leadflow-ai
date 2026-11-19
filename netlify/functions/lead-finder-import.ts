import { handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { importInputSchema, parseOr400 } from './_shared/lead-finder/validation'
import { importCsv } from './_shared/lead-finder/services'
import { leadFinderDeps } from './_shared/lead-finder/deps'

/** POST /api/lead-finder/import — importazione CSV con fonte e base giuridica dichiarate. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(importInputSchema, await readJson(req, 2_000_000))
    const { user } = await requireOrgMember(req, input.organization_id)
    return json(await importCsv(leadFinderDeps(), { orgId: input.organization_id, userId: user.id }, input))
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/lead-finder/import' }
