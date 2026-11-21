import { HttpError, handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { parseOr400 } from './_shared/lead-finder/validation'
import { contentRequestSchema } from './_shared/campaigns/validation'
import { dispatchBackground } from './_shared/dispatch'
import { requestSalesJob } from './_shared/sales-agent/service'
import { salesDeps } from './_shared/sales-agent/deps'
import { requireFeature } from './_shared/billing/access'
import { billingGate } from './_shared/billing/deps'

/** POST /api/campaigns/generate-content — 3 varianti AI per uno step email della campagna (202). */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(contentRequestSchema, await readJson(req, 8_000))
    const { user } = await requireOrgMember(req, input.organization_id)
    // Controllo di piano lato server (402 se la funzionalità non è inclusa o l'abbonamento non è attivo).
    await requireFeature(billingGate(), input.organization_id, 'campaign_manager')
    const { store } = salesDeps()
    const { job_id } = await requestSalesJob(
      { store },
      { orgId: input.organization_id, userId: user.id },
      { task: 'campaign_content', campaign_id: input.campaign_id, position: input.position, instructions: input.instructions },
    )
    if (!(await dispatchBackground('/api/sales-agent/run', req.url, { job_id }))) {
      await store.updateJob(input.organization_id, job_id, { status: 'failed', error: 'dispatch_failed', completedAt: new Date().toISOString() })
      throw new HttpError(502, 'ai_dispatch_failed')
    }
    return json({ job_id, status: 'queued' }, 202)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/campaigns/generate-content' }
