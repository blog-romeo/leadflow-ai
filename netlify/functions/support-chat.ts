import { HttpError, handleError, json, readJson, requireMethod, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { log } from './_shared/log'
import { callStructured } from './_shared/lead-finder/analysis/openai'
import { estimateCostUsd } from './_shared/sales-agent/costs'
import { cleanQuestion } from './_shared/assistant/service'
import { chatAnswer, sanitizeHistory, type ChatDeps } from './_shared/assistant/chat'
import { clientIp, rateKey } from './_shared/launch/hash'
import { createHash } from 'node:crypto'

/**
 * POST /api/support-chat — Chatbot di assistenza clienti (Prompt 13).
 *
 * Due modalità:
 *  • pubblica (nessun organization_id): visitatori del sito. Solo documentazione pubblica, risposta
 *    estrattiva SENZA AI (costo zero, nessun dato salvato). Limite 30 messaggi/ora per IP (hash) e
 *    1.000/ora globali. La conversazione non viene memorizzata.
 *  • app (organization_id + sessione): membri dell'organizzazione. Documentazione completa; AI
 *    opzionale (OPENAI_API_KEY + OPENAI_MODEL) e SEMPRE ancorata agli articoli, registrata come job
 *    'support_assistant' (pausa AI e tetti di spesa del Control Center). 30 messaggi/ora per utente.
 *
 * Il bot non esegue azioni, non legge dati dell'account e non chiede segreti. Quando non trova
 * la risposta lo dice e propone una persona (handoff): in app con un ticket creato dall'utente,
 * sul sito con il modulo /demo. Nessuna comunicazione viene inviata automaticamente.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const body = (await readJson(req, 12_000)) as Record<string, unknown>
    const question = cleanQuestion(body?.question)
    if (!question) throw new HttpError(400, 'invalid_question')
    const locale = body.locale === 'en' ? 'en' : 'it'
    const history = sanitizeHistory(body.history)
    const admin = supabaseAdmin()

    if (typeof body.organization_id !== 'string') {
      const key = rateKey(clientIp(req), 'support_chat')
      if (!key) throw new HttpError(503, 'server_not_configured')
      const [perIp, global] = await Promise.all([
        admin.rpc('public_rate_limit', { p_key_hash: key, p_bucket: 'support_chat', p_max: 30, p_window_minutes: 60 }),
        admin.rpc('public_rate_limit', { p_key_hash: '0'.repeat(64), p_bucket: 'support_chat_global', p_max: 1000, p_window_minutes: 60 }),
      ])
      if (perIp.error || global.error) throw new HttpError(500, 'storage_error')
      if (!perIp.data || !global.data) throw new HttpError(429, 'rate_limited', { retry_after: 900 })
      const reply = await chatAnswer({ question, history, locale, audience: 'public' }, { ai: null })
      log('info', 'support_chat.public', { mode: reply.mode, intent: reply.intent, sources: reply.sources.length })
      return json(reply)
    }

    const orgId = requireUuid(body.organization_id, 'organization_id')
    const { user } = await requireOrgMember(req, orgId)
    const key = createHash('sha256').update(`support_chat:${user.id}`).digest('hex')
    const { data: allowed, error: rlErr } = await admin.rpc('public_rate_limit', { p_key_hash: key, p_bucket: 'support_chat_app', p_max: 30, p_window_minutes: 60 })
    if (rlErr) throw new HttpError(500, 'storage_error')
    if (!allowed) throw new HttpError(429, 'rate_limited', { retry_after: 600 })

    const apiKey = process.env.OPENAI_API_KEY ?? ''
    const model = process.env.OPENAI_MODEL ?? ''
    const deps: ChatDeps = {
      ai: apiKey && model
        ? async (system, userMsg, schema) =>
            callStructured({ apiKey, model, system, user: userMsg, schemaName: 'assistant_answer', schema, timeoutMs: 20_000, maxOutputTokens: 600 })
        : null,
      async startJob() {
        const { data, error } = await admin
          .from('ai_jobs')
          .insert({ organization_id: orgId, type: 'support_assistant', status: 'running', created_by: user.id, input: { locale, channel: 'chat' }, started_at: new Date().toISOString() })
          .select('id')
          .single()
        if (error) throw new Error('job_rejected')
        return (data as { id: string }).id
      },
      async finishJob(id, r) {
        const patch = r.ok
          ? {
              status: 'succeeded',
              tokens_input: r.usage?.input_tokens ?? 0,
              tokens_output: r.usage?.output_tokens ?? 0,
              model: r.model ?? null,
              cost_usd: r.usage ? estimateCostUsd(r.usage) : null,
              output: { article_ids: r.articleIds ?? [] },
              completed_at: new Date().toISOString(),
            }
          : { status: 'failed', error: 'support_chat_ai_failed', completed_at: new Date().toISOString() }
        const { error } = await admin.from('ai_jobs').update(patch).eq('id', id).eq('organization_id', orgId)
        if (error) log('warn', 'support_chat.job_update_failed', {})
      },
    }
    const reply = await chatAnswer({ question, history, locale, audience: 'app' }, deps)
    log('info', 'support_chat.app', { mode: reply.mode, intent: reply.intent, sources: reply.sources.length })
    return json(reply)
  } catch (err) {
    return handleError(err, '/api/support-chat')
  }
}
export const config = { path: '/api/support-chat' }
