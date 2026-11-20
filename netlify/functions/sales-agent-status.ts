import { handleError, json, requireMethod, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { aiMissingConfig } from './_shared/lead-finder/analysisService'
import { profileMissing } from './_shared/sales-agent/context'
import { salesDeps } from './_shared/sales-agent/deps'

/** GET /api/sales-agent/status?organization_id= — configurazione AI e completezza del profilo commerciale. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET')
    const orgId = requireUuid(new URL(req.url).searchParams.get('organization_id'), 'organization_id')
    const { role } = await requireOrgMember(req, orgId)
    const missing = aiMissingConfig()
    const profile = await salesDeps().store.getProfile(orgId)
    return json({
      ai: { configured: missing.length === 0, missing: role === 'organization_admin' ? missing : [] },
      cost_tracking: Boolean(process.env.OPENAI_PRICE_INPUT_PER_MTOK && process.env.OPENAI_PRICE_OUTPUT_PER_MTOK),
      profile: { complete: profileMissing(profile).length === 0, missing: profileMissing(profile) },
    })
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/sales-agent/status' }
