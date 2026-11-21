import { HttpError, handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { dispatchBackground } from './_shared/dispatch'
import { parseOr400 } from './_shared/lead-finder/validation'
import { assertAgentsEnabled } from './_shared/agents/flags'
import { controlInputSchema } from './_shared/agents/validation'

/**
 * POST /api/ai-workflows/control — interruzione, approvazione o rifiuto.
 * Le decisioni passano dalle RPC del database con il JWT dell'UTENTE (non la service role): ruolo,
 * organizzazione, stato e scadenza sono verificati da ai_workflow_request_cancel / ai_agent_decide_approval.
 */
const STATUS: Record<string, number> = { '42501': 403, P0002: 404, P0001: 409, '22023': 400 }

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(controlInputSchema, await readJson(req, 8_000))
    const { db } = await requireOrgMember(req, input.organization_id)
    assertAgentsEnabled(input.organization_id)
    // Il workflow deve appartenere all'organizzazione indicata (lettura con RLS dell'utente).
    const { data: wf, error: we } = await db.from('ai_workflows').select('id, organization_id').eq('id', input.workflow_id).eq('organization_id', input.organization_id).maybeSingle()
    if (we) throw new HttpError(500, 'storage_error')
    if (!wf) throw new HttpError(404, 'workflow_not_found')

    if (input.action === 'cancel') {
      const { data, error } = await db.rpc('ai_workflow_request_cancel', { p_workflow: input.workflow_id })
      if (error) throw new HttpError(STATUS[error.code ?? ''] ?? 500, /^[a-z_]{3,60}$/.test(error.message) ? error.message : 'control_failed')
      return json(data)
    }
    if (!input.approval_id) throw new HttpError(400, 'approval_id_required')
    const { data: ap } = await db.from('ai_agent_approvals').select('workflow_id').eq('id', input.approval_id).maybeSingle()
    if (!ap || ap.workflow_id !== input.workflow_id) throw new HttpError(404, 'approval_not_found')
    const { data, error } = await db.rpc('ai_agent_decide_approval', { p_approval: input.approval_id, p_decision: input.action, p_note: input.note ?? null })
    if (error) throw new HttpError(STATUS[error.code ?? ''] ?? 500, /^[a-z_]{3,60}$/.test(error.message) ? error.message : 'control_failed')
    const dispatched = await dispatchBackground('/api/ai-workflows/run', req.url, { workflow_id: input.workflow_id })
    return json({ ...(data as Record<string, unknown>), dispatched })
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/ai-workflows/control' }
