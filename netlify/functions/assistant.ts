import { HttpError, handleError, json, readJson, requireMethod, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { log } from './_shared/log'
import { callStructured } from './_shared/lead-finder/analysis/openai'
import { estimateCostUsd } from './_shared/sales-agent/costs'
import { answerQuestion, cleanQuestion, type AssistantDeps } from './_shared/assistant/service'
import { createHash } from 'node:crypto'

/**
 * POST /api/assistant { organization_id, question, locale } — Assistente di onboarding.
 * Utente autenticato e membro dell'organizzazione. Risponde solo dalla documentazione;
 * non esegue azioni. Gratuito (nessun credito commerciale), ma ogni chiamata AI è registrata
 * come job 'support_assistant' con token e costo: valgono pausa AI e tetti di spesa del Control Center.
 * Limite: 20 domande all'ora per utente.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const body = (await readJson(req, 4_000)) as Record<string, unknown>
    const orgId = requireUuid(typeof body?.organization_id === 'string' ? body.organization_id : null, 'organization_id')
    const question = cleanQuestion(body.question)
    if (!question) throw new HttpError(400, 'invalid_question')
    const locale = body.locale === 'en' ? 'en' : 'it'
    const { user } = await requireOrgMember(req, orgId)

    const admin = supabaseAdmin()
    const key = createHash('sha256').update(`assistant:${user.id}`).digest('hex')
    const { data: allowed, error: rlErr } = await admin.rpc('public_rate_limit', { p_key_hash: key, p_bucket: 'assistant', p_max: 20, p_window_minutes: 60 })
    if (rlErr) throw new HttpError(500, 'storage_error')
    if (!allowed) throw new HttpError(429, 'rate_limited', { retry_after: 600 })

    const apiKey = process.env.OPENAI_API_KEY ?? ''
    const model = process.env.OPENAI_MODEL ?? ''
    const deps: AssistantDeps = {
      ai: apiKey && model
        ? async (system, userMsg, schema) =>
            callStructured({ apiKey, model, system, user: userMsg, schemaName: 'assistant_answer', schema, timeoutMs: 20_000, maxOutputTokens: 700 })
        : null,
      async startJob() {
        const { data, error } = await admin
          .from('ai_jobs')
          .insert({ organization_id: orgId, type: 'support_assistant', status: 'running', created_by: user.id, input: { locale }, started_at: new Date().toISOString() })
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
          : { status: 'failed', error: 'assistant_ai_failed', completed_at: new Date().toISOString() }
        const { error } = await admin.from('ai_jobs').update(patch).eq('id', id).eq('organization_id', orgId)
        if (error) log('warn', 'assistant.job_update_failed', {})
      },
    }
    const result = await answerQuestion(question, locale, deps)
    log('info', 'assistant.answered', { mode: result.mode, sources: result.sources.length })
    return json(result)
  } catch (err) {
    return handleError(err, '/api/assistant')
  }
}
export const config = { path: '/api/assistant' }
