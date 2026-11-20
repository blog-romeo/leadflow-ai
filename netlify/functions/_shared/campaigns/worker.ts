import { HttpError } from '../http'
import { log } from '../log'
import { composeEmail } from './compose'
import { decryptSecret } from './crypto'
import { ProviderError, type EmailProvider } from './providers/types'
import { sanitizeUntrusted } from '../sales-agent/sanitize'
import type { AutomationJob, CampaignStore, PendingEvent } from './store'
import { secondsUntilWindow } from './window'

/**
 * Motore di esecuzione dei job (Netlify: scheduled function ogni minuto + background
 * function fino a 15 minuti). Garanzie:
 * - ogni job ha una chiave di idempotenza univoca e un lease (più worker in parallelo sono sicuri);
 * - prima di OGNI invio il database ripete tutti i controlli (public.begin_send);
 * - la chiamata al provider usa la chiave di idempotenza del messaggio: un nuovo tentativo dopo
 *   un timeout non produce un secondo invio;
 * - errori transitori → retry con backoff esponenziale; esauriti i tentativi → dead-letter;
 * - errori permanenti → stop del destinatario; credenziali rifiutate → account in errore e
 *   campagne sospese (trigger nel database).
 */
export interface WorkerDeps {
  store: CampaignStore
  providers: Record<EmailProvider['id'], EmailProvider>
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Avvia un suggerimento AI per un promemoria (best effort, non blocca la sequenza). */
  requestFollowUpAi?: (org: string, userId: string, taskId: string) => Promise<void>
  /** Avvia l'analisi AI di una risposta ricevuta (best effort). */
  requestInboundAnalysis?: (org: string, inboundId: string) => Promise<void>
  /** Avvia la generazione di bozze per un lead (azione dei workflow). */
  requestDraft?: (org: string, userId: string, leadId: string, channel: string) => Promise<void>
}

type Outcome = { outcome: 'succeeded' | 'retry' | 'cancelled' | 'dead' | 'deferred'; error?: string; retrySeconds?: number }

const appUrl = (env: NodeJS.ProcessEnv) => env.URL ?? env.VITE_APP_URL ?? 'http://localhost:8888'

// ════════════════════════════════════════════════════════════════════════════
// Invio di un messaggio (campagna, risposta, prova)
// ════════════════════════════════════════════════════════════════════════════
export async function sendMessage(deps: WorkerDeps, job: Pick<AutomationJob, 'id' | 'attempts' | 'max_attempts'>, messageId: string): Promise<Outcome & { sent?: boolean }> {
  const { store } = deps
  const env = deps.env ?? process.env
  const b = await store.beginSend(messageId)
  if (!b.ok) {
    if (b.reason === 'already_sent') return { outcome: 'succeeded', sent: true }
    if (!b.permanent) return { outcome: 'deferred', retrySeconds: b.retry_seconds ?? 60, error: b.reason }
    return { outcome: 'cancelled', error: b.reason }
  }
  const provider = deps.providers[b.provider]
  const account = await store.getAccount(null, b.account_id)
  const secrets = await store.getAccountSecrets(b.account_id)
  if (!provider?.implemented || !account || !secrets?.api_key_ciphertext) {
    await store.finishSend(messageId, 'requeue', null, 'provider_unavailable')
    return { outcome: 'cancelled', error: 'provider_unavailable' }
  }
  const sender = await store.getSenderIdentity(account.organization_id)
  if (!sender) {
    await store.finishSend(messageId, 'requeue', null, 'sender_identity_missing')
    return { outcome: 'cancelled', error: 'sender_identity_missing' }
  }
  const apiKey = decryptSecret(secrets.api_key_ciphertext, `api_key:${account.id}`, env)
  const email = composeEmail(
    {
      messageId,
      kind: b.kind,
      fromName: b.from_name,
      fromEmail: b.from_email,
      replyTo: b.reply_to,
      to: b.to_email,
      subject: b.subject,
      body: b.body_text,
      language: b.language,
      basis: b.basis,
      sourceName: b.source_name,
      sender,
      appUrl: appUrl(env),
      campaignId: b.campaign_id,
    },
    env,
  )
  try {
    const r = await provider.send(apiKey, email, b.idempotency_key)
    await store.finishSend(messageId, 'sent', r.id)
    log('info', 'campaign.message_sent', { message_id: messageId, kind: b.kind, resume: b.resume })
    return { outcome: 'succeeded', sent: true }
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError('transient', 'unexpected_error')
    log('warn', 'campaign.send_failed', { message_id: messageId, kind: e.kind, code: e.code, status: e.status, attempt: job.attempts })
    if (e.kind === 'auth') {
      // Rifiuto certo: nessun invio. L'account va in errore e le campagne vengono sospese.
      await store.finishSend(messageId, 'requeue', null, `provider_auth:${e.code}`)
      await store.setAccountStatus(b.account_id, { status: 'error', last_error: `Credenziali rifiutate dal provider (${e.code})` })
      return { outcome: 'cancelled', error: 'provider_auth' }
    }
    if (e.kind === 'transient') {
      if (job.attempts >= job.max_attempts) {
        await store.finishSend(messageId, 'unknown', null, e.code)
        return { outcome: 'dead', error: `send_outcome_unknown:${e.code}` }
      }
      await store.finishSend(messageId, 'retry', null, e.code)
      return { outcome: 'retry', error: e.code }
    }
    if (e.kind === 'idempotency_conflict') {
      await store.finishSend(messageId, 'unknown', null, e.code)
      return { outcome: 'dead', error: e.code }
    }
    await store.finishSend(messageId, 'failed', null, e.code)
    return { outcome: 'dead', error: `permanent:${e.code}` }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Step di una sequenza
// ════════════════════════════════════════════════════════════════════════════
async function runStep(deps: WorkerDeps, job: AutomationJob): Promise<Outcome> {
  const { store } = deps
  const recipientId = String(job.payload.recipient_id ?? '')
  const stepId = String(job.payload.step_id ?? '')
  const ctx = await store.getStepContext(recipientId, stepId)
  if (!ctx) return { outcome: 'cancelled', error: 'step_not_found' }
  if (ctx.campaign.status !== 'running') return { outcome: 'cancelled', error: `campaign_${ctx.campaign.status}` }
  if (ctx.recipient.status !== 'in_sequence') return { outcome: 'cancelled', error: `recipient_${ctx.recipient.status}` }
  const now = (deps.now ?? (() => new Date()))()
  const org = ctx.recipient.organization_id
  const leadId = ctx.recipient.lead_id

  if (ctx.step.kind === 'email' || ctx.step.kind === 'follow_up_email') {
    const wait = secondsUntilWindow(now, {
      timezone: ctx.campaign.timezone,
      startHour: ctx.campaign.send_hour_start,
      endHour: ctx.campaign.send_hour_end,
      weekdaysOnly: ctx.campaign.weekdays_only,
    })
    if (wait > 0) return { outcome: 'deferred', retrySeconds: wait, error: 'outside_send_window' }
    const msg = await store.prepareStepMessage(recipientId, stepId)
    const r = await sendMessage(deps, job, msg.id)
    if (r.outcome === 'succeeded') {
      await store.advanceRecipient(recipientId, ctx.step.position)
      return r
    }
    if (r.outcome === 'dead' && r.error?.startsWith('permanent:')) await store.stopRecipient(recipientId, 'send_failed')
    return r
  }

  // Step interni: nessun contatto, solo promemoria e suggerimenti per una persona.
  const due = now.toISOString()
  const isReview = ctx.step.kind === 'ai_review'
  const lead = await store.getLead(org, leadId)
  const taskId = await store.createTask({
    org,
    leadId,
    kind: isReview ? 'check_in' : 'opportunity_review',
    title: isReview ? `Verifica risposta e stato · ${ctx.campaign.name}` : `Revisione opportunità · ${ctx.campaign.name}`,
    notes: isReview
      ? 'Controlla se il contatto ha risposto o ha mostrato interesse. Il suggerimento AI è indicativo: decidi tu il passo successivo.'
      : 'Fine sequenza: chiudi, rimanda o trasforma in opportunità. Nessun messaggio verrà inviato automaticamente.',
    dueAt: due,
    source: 'campaign',
    recipientId,
    assignedTo: ctx.campaign.activated_by,
  }).catch((err) => {
    // Lead diventato non contattabile: il promemoria di contatto non si crea, la sequenza prosegue verso la chiusura.
    log('warn', 'campaign.task_not_created', { recipient_id: recipientId, code: (err as Error).message?.slice(0, 80) })
    return null
  })
  if (isReview && taskId && ctx.campaign.activated_by && deps.requestFollowUpAi && lead?.contact_status === 'active') {
    await deps.requestFollowUpAi(org, ctx.campaign.activated_by, taskId).catch((err) =>
      log('warn', 'campaign.ai_review_not_started', { code: (err as Error).message?.slice(0, 80) }),
    )
  }
  await store.advanceRecipient(recipientId, ctx.step.position)
  return { outcome: 'succeeded' }
}

// ════════════════════════════════════════════════════════════════════════════
// Risposte in arrivo (webhook → job): lettura del contenuto e collegamento al CRM
// ════════════════════════════════════════════════════════════════════════════
const AUTO_REPLY = /\b(out of office|automatic reply|auto-?reply|risposta automatica|fuori ufficio|assente)\b/i

async function ingestInbound(deps: WorkerDeps, job: AutomationJob): Promise<Outcome> {
  const { store } = deps
  const env = deps.env ?? process.env
  const accountId = String(job.payload.account_id ?? '')
  const emailId = String(job.payload.email_id ?? '')
  const account = await store.getAccount(job.organization_id, accountId)
  if (!account || account.status === 'revoked') return { outcome: 'cancelled', error: 'account_unavailable' }
  const secrets = await store.getAccountSecrets(accountId)
  if (!secrets?.api_key_ciphertext) return { outcome: 'cancelled', error: 'account_unavailable' }
  const provider = deps.providers[account.provider]
  let received
  try {
    received = await provider.getReceived(decryptSecret(secrets.api_key_ciphertext, `api_key:${account.id}`, env), emailId)
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError('transient', 'unexpected')
    if (e.kind === 'transient') return { outcome: 'retry', error: e.code }
    return { outcome: 'dead', error: e.code }
  }
  const fromEmail = (/<([^>]+)>/.exec(received.from)?.[1] ?? received.from).trim().toLowerCase().slice(0, 320)
  const lead = await store.findLeadByEmail(job.organization_id, fromEmail)
  const last = await store.latestOutboundTo(accountId, fromEmail)
  const plain = received.text ?? (received.html ? received.html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : '')
  // Testo esterno: sanificato e troncato prima di essere salvato o passato all'AI.
  const body = sanitizeUntrusted(plain.replace(/\r/g, ''), 20000)
  const r = await store.insertInbound({
    organization_id: job.organization_id,
    account_id: accountId,
    provider_message_id: emailId,
    lead_id: lead?.id ?? last?.lead_id ?? null,
    recipient_id: last?.recipient_id ?? null,
    outbound_message_id: last?.id ?? null,
    from_email: fromEmail,
    subject: received.subject ? sanitizeUntrusted(received.subject, 300) : null,
    body_text: body,
    received_at: received.receivedAt,
  })
  if (!r.duplicate) {
    const auto = AUTO_REPLY.test(`${received.subject ?? ''} ${received.headers['auto-submitted'] ?? ''}`) && received.headers['auto-submitted'] !== 'no'
    await store.notify(job.organization_id, null, auto ? 'Risposta automatica ricevuta' : 'Nuova risposta ricevuta', lead ? lead.company_name : fromEmail, '/app/inbox')
    if (deps.requestInboundAnalysis) {
      await deps.requestInboundAnalysis(job.organization_id, r.id).catch((err) =>
        log('warn', 'inbound.analysis_not_started', { code: (err as Error).message?.slice(0, 80) }),
      )
    }
  }
  return { outcome: 'succeeded' }
}

// ════════════════════════════════════════════════════════════════════════════
// Azioni dei workflow
// ════════════════════════════════════════════════════════════════════════════
async function runAction(deps: WorkerDeps, job: AutomationJob): Promise<Outcome> {
  const { store } = deps
  const wf = await store.getWorkflow(String(job.payload.workflow_id ?? ''))
  // Arresto immediato: un workflow sospeso o modificato non esegue più azioni in coda.
  if (!wf || wf.status !== 'running' || wf.organization_id !== job.organization_id) return { outcome: 'cancelled', error: 'workflow_not_running' }
  const action = wf.actions[Number(job.payload.action_index ?? -1)]
  if (!action) return { outcome: 'cancelled', error: 'action_not_found' }
  const leadId = typeof job.payload.lead_id === 'string' ? job.payload.lead_id : null
  const lead = leadId ? await store.getLead(job.organization_id, leadId) : null
  const now = (deps.now ?? (() => new Date()))()
  try {
    switch (action.type) {
      case 'create_activity':
        if (lead) await store.logActivity(job.organization_id, lead.id, `Automazione «${wf.name}»: ${String(action.text ?? job.payload.event_type)}`.slice(0, 300), { workflow_id: wf.id, job_id: job.id })
        break
      case 'notify':
        await store.notify(job.organization_id, null, String(action.title ?? wf.name).slice(0, 200), lead ? lead.company_name : String(job.payload.event_type), lead ? `/app/sales-agent/leads/${lead.id}` : '/app/automations')
        break
      case 'update_lead_status':
        if (lead) await store.updateLeadStatus(job.organization_id, lead.id, String(action.status))
        break
      case 'create_reminder':
      case 'prepare_follow_up': {
        if (!lead) break
        const days = Math.min(90, Math.max(0, Number(action.days ?? (action.type === 'prepare_follow_up' ? 3 : 1))))
        const taskId = await store.createTask({
          org: job.organization_id,
          leadId: lead.id,
          kind: action.type === 'prepare_follow_up' ? 'check_in' : 'custom',
          title: String(action.title ?? (action.type === 'prepare_follow_up' ? `Follow-up · ${lead.company_name}` : `Promemoria · ${wf.name}`)).slice(0, 200),
          notes: `Creato dall'automazione «${wf.name}».`,
          dueAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
          source: 'automation',
          jobId: job.id,
          assignedTo: wf.approved_by,
        })
        if (action.type === 'prepare_follow_up' && taskId && wf.approved_by && deps.requestFollowUpAi) await deps.requestFollowUpAi(job.organization_id, wf.approved_by, taskId).catch(() => undefined)
        break
      }
      case 'generate_draft':
        if (lead && lead.contact_status === 'active' && wf.approved_by && deps.requestDraft) await deps.requestDraft(job.organization_id, wf.approved_by, lead.id, String(action.channel ?? 'email'))
        break
      default:
        return { outcome: 'cancelled', error: 'unsupported_action' }
    }
    await store.recordWorkflowRun(wf.id, null)
    return { outcome: 'succeeded' }
  } catch (err) {
    const code = err instanceof HttpError ? err.code : ((err as Error)?.message ?? 'error').slice(0, 120)
    await store.recordWorkflowRun(wf.id, code)
    // Errori di dominio (es. lead non contattabile) sono definitivi; il resto si ritenta.
    return /not_contactable|forbidden|invalid|P0001|23/.test(code) ? { outcome: 'dead', error: code } : { outcome: 'retry', error: code }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Eventi → workflow (fan-out idempotente) e notifiche di sistema
// ════════════════════════════════════════════════════════════════════════════
function matches(cond: Record<string, unknown>, ev: PendingEvent, lead: { score: number | null; status: string; industry: string | null } | null): boolean {
  if (typeof cond.campaign_id === 'string' && cond.campaign_id !== ev.campaign_id) return false
  if (typeof cond.min_score === 'number' && (lead?.score ?? 0) < cond.min_score) return false
  if (Array.isArray(cond.lead_statuses) && cond.lead_statuses.length && !cond.lead_statuses.includes(lead?.status)) return false
  if (typeof cond.industry === 'string' && cond.industry.trim() && (lead?.industry ?? '').toLowerCase() !== cond.industry.toLowerCase()) return false
  return true
}

export async function processEvents(deps: WorkerDeps, limit = 200): Promise<number> {
  const { store } = deps
  const events = await store.fetchPendingEvents(limit)
  for (const ev of events) {
    const workflows = await store.runningWorkflows(ev.organization_id, ev.type)
    const lead = ev.lead_id ? await store.getLead(ev.organization_id, ev.lead_id) : null
    for (const wf of workflows) {
      if (!matches(wf.conditions ?? {}, ev, lead)) continue
      for (let i = 0; i < wf.actions.length; i++) {
        await store.enqueueJob({
          org: ev.organization_id,
          kind: 'run_action',
          key: `wf:${wf.id}:${ev.id}:${i}`,
          payload: { workflow_id: wf.id, action_index: i, event_id: ev.id, event_type: ev.type, lead_id: ev.lead_id, campaign_id: ev.campaign_id },
          campaignId: ev.campaign_id,
          workflowId: wf.id,
        })
      }
    }
  }
  await store.markEventsProcessed(events.map((e) => e.id))
  return events.length
}

// ════════════════════════════════════════════════════════════════════════════
// Esecuzione
// ════════════════════════════════════════════════════════════════════════════
export async function processJob(deps: WorkerDeps, job: AutomationJob): Promise<Outcome> {
  const started = Date.now()
  let r: Outcome
  try {
    switch (job.kind) {
      case 'run_step':
        r = await runStep(deps, job)
        break
      case 'send_message':
        r = await sendMessage(deps, job, String(job.payload.message_id ?? ''))
        break
      case 'ingest_inbound':
        r = await ingestInbound(deps, job)
        break
      case 'run_action':
        r = await runAction(deps, job)
        break
      default:
        r = { outcome: 'cancelled', error: 'unsupported_job' }
    }
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 'internal_error'
    log('error', 'automation.job_error', { job_id: job.id, kind: job.kind, code, message: (err as Error)?.message?.slice(0, 160) })
    r = { outcome: 'retry', error: code }
  }
  if (r.outcome === 'deferred') await deps.store.deferJob(job.id, r.retrySeconds ?? 60)
  else await deps.store.finishJob(job.id, r.outcome, r.error ?? null, r.retrySeconds ?? null)
  log(r.outcome === 'dead' ? 'error' : 'info', 'automation.job_done', { job_id: job.id, kind: job.kind, outcome: r.outcome, code: r.error, attempt: job.attempts, ms: Date.now() - started })
  return r
}

/** Elabora job finché ce ne sono e resta tempo (lease più lungo del tempo per job). */
export async function runWorker(deps: WorkerDeps, opts: { workerId: string; budgetMs: number; batch?: number }): Promise<{ processed: number }> {
  const deadline = Date.now() + opts.budgetMs
  let processed = 0
  while (Date.now() < deadline - 20_000) {
    const jobs = await deps.store.claimJobs(opts.workerId, opts.batch ?? 10, 180)
    if (jobs.length === 0) break
    for (const job of jobs) {
      if (Date.now() > deadline - 20_000) {
        // Fuori tempo: il job torna disponibile alla scadenza del lease.
        break
      }
      await processJob(deps, job)
      processed++
    }
  }
  return { processed }
}

/** Manutenzione periodica: step in scadenza, eventi → workflow. Restituisce i job pronti. */
export async function tick(deps: WorkerDeps): Promise<{ scheduled: number; events: number; due: number }> {
  const scheduled = await deps.store.scheduleDueSteps(500)
  const events = await processEvents(deps)
  const due = await deps.store.countDueJobs()
  return { scheduled, events, due }
}
