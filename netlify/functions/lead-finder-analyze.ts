import { handleError, HttpError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { analyzeInputSchema, parseOr400 } from './_shared/lead-finder/validation'
import { requestAnalysis } from './_shared/lead-finder/analysisService'
import { leadFinderDeps } from './_shared/lead-finder/deps'
import { log } from './_shared/log'
import { requireFeature } from './_shared/billing/access'
import { billingGate } from './_shared/billing/deps'

/**
 * POST /api/lead-finder/analyze — avvia l'analisi AI di un candidato.
 * Controlli sincroni qui; l'esecuzione (sito + OpenAI) gira nella background function.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(analyzeInputSchema, await readJson(req, 16_000))
    const { user } = await requireOrgMember(req, input.organization_id)
    // Controllo di piano lato server (402 se la funzionalità non è inclusa o l'abbonamento non è attivo).
    await requireFeature(billingGate(), input.organization_id, 'ai_analyzer')
    const { store } = leadFinderDeps()
    const ctx = { orgId: input.organization_id, userId: user.id }
    const { job_id } = await requestAnalysis({ store }, ctx, input)

    const target = new URL('/api/lead-finder/analyze-run', process.env.URL ?? req.url)
    const dispatch = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-leadflow-internal': process.env.LEADFLOW_INTERNAL_SECRET ?? '' },
      body: JSON.stringify({ job_id }),
    }).catch(() => null)
    if (!dispatch || dispatch.status >= 400) {
      log('error', 'lead_analysis.dispatch_failed', { status: dispatch?.status })
      await store.updateAiJob(ctx.orgId, job_id, { status: 'failed', error: 'dispatch_failed', completedAt: new Date().toISOString(), input: {} })
      throw new HttpError(502, 'ai_dispatch_failed')
    }
    return json({ job_id, status: 'queued' }, 202)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/lead-finder/analyze' }
