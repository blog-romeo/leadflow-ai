import { handleError, json, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'

/**
 * GET /api/ai-status?organization_id=<uuid>
 * Restituisce lo stato reale dei moduli AI per l'organizzazione dell'utente.
 * Esempio del pattern di autorizzazione che useranno tutti gli endpoint AI.
 * La chiave OpenAI non viene mai restituita: solo se è configurata.
 */
const AI_MODULES = ['lead_finder', 'business_analysis', 'lead_scoring', 'sales_agent', 'follow_up'] as const

export default async (req: Request): Promise<Response> => {
  try {
    if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
    const orgId = requireUuid(new URL(req.url).searchParams.get('organization_id'), 'organization_id')
    await requireOrgMember(req, orgId)
    return json({
      organization_id: orgId,
      provider_configured: Boolean(process.env.OPENAI_API_KEY),
      modules: AI_MODULES.map((key) => ({ key, status: 'preparation' as const })),
    })
  } catch (err) {
    return handleError(err)
  }
}
