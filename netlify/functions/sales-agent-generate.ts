import { handleError, HttpError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { dispatchBackground } from './_shared/dispatch'
import { generateInputSchema } from './_shared/sales-agent/validation'
import { parseOr400 } from './_shared/lead-finder/validation'
import { requestSalesJob } from './_shared/sales-agent/service'
import { salesDeps } from './_shared/sales-agent/deps'

/**
 * POST /api/sales-agent/generate — avvia una generazione AI (intelligence, messaggi,
 * proposta, suggerimento follow-up). Restituisce 202 con l'id del job; nessun invio.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(generateInputSchema, await readJson(req, 16_000))
    const { user } = await requireOrgMember(req, input.organization_id)
    const { store } = salesDeps()
    const ctx = { orgId: input.organization_id, userId: user.id }
    const { job_id } = await requestSalesJob({ store }, ctx, input)
    if (!(await dispatchBackground('/api/sales-agent/run', req.url, { job_id }))) {
      await store.updateJob(ctx.orgId, job_id, { status: 'failed', error: 'dispatch_failed', completedAt: new Date().toISOString() })
      throw new HttpError(502, 'ai_dispatch_failed')
    }
    return json({ job_id, status: 'queued' }, 202)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/sales-agent/generate' }
