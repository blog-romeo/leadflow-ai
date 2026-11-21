import { handleError, HttpError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { dispatchBackground } from './_shared/dispatch'
import { copilotInputSchema } from './_shared/sales-agent/validation'
import { parseOr400 } from './_shared/lead-finder/validation'
import { requestCopilot } from './_shared/sales-agent/service'
import { salesDeps } from './_shared/sales-agent/deps'
import { requireFeature } from './_shared/billing/access'
import { billingGate } from './_shared/billing/deps'

/** POST /api/sales-agent/copilot — domanda al copilota (solo dati dell'organizzazione autenticata). */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(copilotInputSchema, await readJson(req, 16_000))
    const { user } = await requireOrgMember(req, input.organization_id)
    // Controllo di piano lato server (402 se la funzionalità non è inclusa o l'abbonamento non è attivo).
    await requireFeature(billingGate(), input.organization_id, 'ai_sales_agent')
    const { store } = salesDeps()
    const ctx = { orgId: input.organization_id, userId: user.id }
    const r = await requestCopilot({ store }, ctx, input)
    if (!(await dispatchBackground('/api/sales-agent/run', req.url, { job_id: r.job_id }))) {
      await store.updateJob(ctx.orgId, r.job_id, { status: 'failed', error: 'dispatch_failed', completedAt: new Date().toISOString() })
      throw new HttpError(502, 'ai_dispatch_failed')
    }
    return json({ ...r, status: 'queued' }, 202)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/sales-agent/copilot' }
