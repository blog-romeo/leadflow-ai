import { handleError, json, requireMethod, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { agentsEnabledFor, agentsFlag } from './_shared/agents/flags'
import { agentCatalog, gatherAvailability } from './_shared/agents/service'
import { agentServiceDeps } from './_shared/agents/deps'
import { supabaseAdmin } from './_shared/supabaseAdmin'

/**
 * GET /api/ai-agents/status?organization_id= — stato reale del motore multi-agent per l'organizzazione:
 * feature flag, catalogo agenti (allowlist degli strumenti), configurazioni mancanti (nomi delle variabili
 * solo agli amministratori), spesa del mese. Non avvia nulla.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET')
    const orgId = requireUuid(new URL(req.url).searchParams.get('organization_id'), 'organization_id')
    const { user, role } = await requireOrgMember(req, orgId)
    if (!agentsEnabledFor(orgId)) {
      return json({ enabled: false, pilot: agentsFlag().enabled && !!agentsFlag().pilotOrgs })
    }
    const deps = agentServiceDeps()
    const ctx = { orgId, userId: user.id, isAdmin: role === 'organization_admin' }
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
    const [availability, spend, checks] = await Promise.all([
      gatherAvailability(deps, ctx),
      deps.store.getMonthlySpend(orgId, monthStart),
      // Prompt 10: ultimo esito REALE delle verifiche di connessione (assente = mai verificato).
      supabaseAdmin().rpc('integration_checks_latest').then((r: { data: unknown; error: unknown }) => (r.error ? [] : (r.data as unknown[]) ?? [])),
    ])
    return json({ enabled: true, is_admin: ctx.isAdmin, catalog: agentCatalog(), availability, spend_month: spend, connections: checks })
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/ai-agents/status' }
