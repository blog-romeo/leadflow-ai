import { HttpError, handleError, json, readJson, requireMethod } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { parseOr400 } from './_shared/lead-finder/validation'
import { inboxActionSchema } from './_shared/campaigns/validation'
import { campaignDeps, dispatchWorker } from './_shared/campaigns/deps'
import { dispatchBackground } from './_shared/dispatch'
import { requestSalesJob } from './_shared/sales-agent/service'
import { salesDeps } from './_shared/sales-agent/deps'
import { requireFeature } from './_shared/billing/access'
import { billingGate } from './_shared/billing/deps'

/**
 * POST /api/inbox/actions
 * - reply: invia una risposta confermata esplicitamente dall'utente (passa da begin_send);
 * - analyze: (ri)avvia l'analisi AI della risposta ricevuta.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const input = parseOr400(inboxActionSchema, await readJson(req, 16_000))
    const { user, db } = await requireOrgMember(req, input.organization_id)
    // Controllo di piano lato server (402 se la funzionalità non è inclusa o l'abbonamento non è attivo).
    await requireFeature(billingGate(), input.organization_id, 'campaign_manager')
    // Lettura con il client dell'utente: RLS garantisce che la risposta sia della sua organizzazione.
    const { data: inbound } = await db.from('inbound_messages').select('id, lead_id, account_id, from_email, subject').eq('organization_id', input.organization_id).eq('id', input.inbound_id).maybeSingle()
    if (!inbound) throw new HttpError(404, 'inbound_not_found')

    if (input.action === 'analyze') {
      const { store } = salesDeps()
      const { job_id } = await requestSalesJob({ store }, { orgId: input.organization_id, userId: user.id }, { task: 'inbound_analysis', inbound_id: inbound.id })
      if (!(await dispatchBackground('/api/sales-agent/run', req.url, { job_id }))) throw new HttpError(502, 'ai_dispatch_failed')
      return json({ job_id }, 202)
    }

    if (!inbound.lead_id) throw new HttpError(409, 'reply_requires_crm_lead')
    const deps = campaignDeps()
    const account = await deps.store.getAccount(input.organization_id, inbound.account_id)
    if (!account || account.status !== 'connected') throw new HttpError(409, 'provider_not_connected')
    const { id, duplicate } = await deps.store.createOutbound({
      org: input.organization_id,
      kind: 'reply',
      accountId: account.id,
      leadId: inbound.lead_id,
      inReplyTo: inbound.id,
      to: inbound.from_email,
      subject: input.subject,
      body: input.body,
      // Un doppio clic non produce due risposte.
      idempotencyKey: `reply:${inbound.id}:${user.id}`,
      confirmedBy: user.id,
    })
    if (duplicate) throw new HttpError(409, 'reply_already_sent')
    await deps.store.enqueueJob({ org: input.organization_id, kind: 'send_message', key: `send:${id}`, payload: { message_id: id, account_id: account.id }, maxAttempts: 5 })
    await db.from('inbound_messages').update({ handled_at: new Date().toISOString() }).eq('id', inbound.id)
    await dispatchWorker()
    return json({ message_id: id, status: 'queued' }, 202)
  } catch (err) {
    return handleError(err)
  }
}

export const config = { path: '/api/inbox/actions' }
