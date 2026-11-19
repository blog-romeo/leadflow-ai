import { handleError, json, requireMethod, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { createRegistry } from './_shared/lead-finder/providers/registry'
import { aiMissingConfig } from './_shared/lead-finder/analysisService'

/** GET /api/lead-finder/providers?organization_id= — stato reale dei provider e dell'AI. */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET')
    const orgId = requireUuid(new URL(req.url).searchParams.get('organization_id'), 'organization_id')
    const { role } = await requireOrgMember(req, orgId)
    const registry = createRegistry()
    const isAdmin = role === 'organization_admin'
    const aiMissing = aiMissingConfig()
    return json({
      providers: Object.values(registry).map((p) => {
        const missing = p.missingConfig()
        return {
          id: p.id,
          label: p.label,
          configured: missing.length === 0,
          // I nomi delle variabili mancanti sono mostrati solo agli amministratori.
          missing: isAdmin ? missing : [],
          license: p.license,
          capabilities: p.capabilities,
        }
      }),
      csv_import: { configured: true },
      ai: { configured: aiMissing.length === 0, missing: isAdmin ? aiMissing : [] },
    })
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/lead-finder/providers' }
