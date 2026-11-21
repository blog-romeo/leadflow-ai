import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { aiMissingConfig } from '../../lead-finder/analysisService'
import { AiError } from '../../lead-finder/analysis/openai'
import { allowedValues, isContactable, leadForModel, profileForModel, profileMissing, type LeadRaw } from '../../sales-agent/context'
import { checkText, dedupeWarnings, factSupported, type Warning } from '../../sales-agent/postcheck'
import { BASE_RULES, buildUserPrompt, styleRules } from '../../sales-agent/prompts'
import { sanitizeDeep, sanitizeUntrusted, type SanitizeStats } from '../../sales-agent/sanitize'
import { complianceWarnings, defaultAiCaller } from '../../sales-agent/service'
import { AgentError, toAgentError } from '../errors'
import type { StepContext, StepHandler, StepResult } from '../engine'
import { AGENT_MAX_OUTPUT_TOKENS, envForTask, estimateTierCost } from '../models'
import type { EvidenceWrite } from '../types'

/**
 * AI Sales Strategy Agent.
 *
 * Input: profilo dell'azienda cliente, prodotti e servizi, lead qualificato, evidenze del Research Agent
 * (FACT/INFERENCE/UNKNOWN), storico CRM del lead, obiettivo commerciale, memoria approvata dell'organizzazione.
 * Output: opportunità, servizio consigliato, motivazione, proposta di valore, obiezioni, strategia di approccio,
 * call to action e una BOZZA (message_drafts, stato "draft"): nessun invio automatico, nessuna promessa di risultato.
 */
const str = { type: 'string' } as const
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const arr = (items: unknown) => ({ type: 'array', items })

export const strategyJsonSchema = obj({
  opportunity: obj({ statement: str, basis: { type: 'string', enum: ['fact', 'inference'] }, evidence: str }),
  recommended_service_id: { type: ['string', 'null'] },
  service_rationale: str,
  value_proposition: str,
  objections: arr(obj({ objection: str, response: str })),
  approach: obj({ channel: { type: 'string', enum: ['email', 'phone', 'linkedin', 'meeting'] }, steps: arr(str) }),
  call_to_action: str,
  draft: { anyOf: [obj({ subject: str, body: str }), { type: 'null' }] },
  assumptions: arr(str),
  missing_information: arr(str),
})

export const strategySchema = z.object({
  opportunity: z.object({ statement: z.string().min(1).max(1200), basis: z.enum(['fact', 'inference']), evidence: z.string().max(1200) }),
  recommended_service_id: z.string().max(100).nullable(),
  service_rationale: z.string().max(1500),
  value_proposition: z.string().min(1).max(1500),
  objections: z.array(z.object({ objection: z.string().max(400), response: z.string().max(800) })).max(6),
  approach: z.object({ channel: z.enum(['email', 'phone', 'linkedin', 'meeting']), steps: z.array(z.string().max(400)).max(6) }),
  call_to_action: z.string().max(400),
  draft: z.object({ subject: z.string().max(200), body: z.string().max(4000) }).nullable(),
  assumptions: z.array(z.string().max(400)).max(8),
  missing_information: z.array(z.string().max(300)).max(8),
})
export type StrategyOutput = z.infer<typeof strategySchema>

export const STRATEGY_TASK = `COMPITO: AI Sales Strategy. Prepara una strategia commerciale per il lead indicato nei dati, a supporto del team commerciale (che deciderà se e come usarla).
- opportunity: l'opportunità commerciale. basis "fact" SOLO se supportata da un dato presente in research.facts (riporta l'estratto in evidence); altrimenti basis "inference" ed evidence vuota.
- recommended_service_id: id di un servizio del profilo (null se nessuno è adatto) e service_rationale.
- value_proposition: proposta di valore formulata come possibilità, senza numeri di risultato né garanzie.
- objections: possibili obiezioni (sono ipotesi) con una risposta onesta.
- approach: canale suggerito e passi concreti; il contatto è sempre eseguito da una persona.
- call_to_action: quella del profilo, se presente.
- draft: bozza email breve (oggetto e corpo, max 1500 caratteri) SOLO se lead.contactable è true, altrimenti null. Saluto generico o [Nome].
- assumptions e missing_information: ipotesi fatte e informazioni che mancano.
Non attribuire al lead bisogni, budget o intenzioni di acquisto che non risultano dai fatti. Tieni conto della memoria approvata (preferenze di comunicazione, strategie già approvate, feedback) solo come indicazione di stile.`

interface StrategyItem {
  lead_id: string
  company_name: string | null
  status: 'generated' | 'cached' | 'failed' | 'skipped_not_found'
  contactable?: boolean
  strategy?: Record<string, unknown>
  draft_id?: string | null
  warnings?: Warning[]
  error?: string
}

function evidenceForModel(rows: EvidenceWrite[], stats: SanitizeStats) {
  const pick = (k: string) =>
    rows
      .filter((r) => r.kind === k)
      .slice(0, 15)
      .map((r) => sanitizeDeep({ category: r.category, statement: r.statement, evidence: r.evidence, source: r.sourceType }, 400, stats))
  return { facts: pick('fact'), inferences: pick('inference'), unknowns: pick('unknown') }
}

export const strategyHandler: StepHandler = {
  agent: 'strategy',
  async run(ctx: StepContext): Promise<StepResult> {
    const saved = ctx.prior(4)
    const results = (saved?.results as { candidate_id: string; lead_id?: string; outcome: string }[] | undefined) ?? []
    const targets = results.filter((r) => r.lead_id && (r.outcome === 'saved' || r.outcome === 'already_saved'))
    const { env: tierEnv, choice } = envForTask('sales_strategy', ctx.config.modelTier, ctx.env)
    const missingCfg = aiMissingConfig({ ...tierEnv, LEADFLOW_INTERNAL_SECRET: ctx.env.LEADFLOW_INTERNAL_SECRET })
    if (missingCfg.length) throw new AgentError('ai_not_configured', { stopWorkflow: true, details: { missing: missingCfg } })
    const sales = ctx.services.sales
    const profile = await ctx.tools.call('profile.read', {}, () => sales.getProfile(ctx.orgId))
    const missingProfile = profileMissing(profile)
    if (missingProfile.length) throw new AgentError('sales_profile_incomplete', { stopWorkflow: true, details: { missing: missingProfile } })
    const memory = await ctx.tools.call('memory.read', { categories: 3 }, () => ctx.store.getMemory(ctx.orgId, ['communication_preferences', 'approved_strategies', 'user_feedback'], 8))
    const ai = ctx.services.ai ?? defaultAiCaller(tierEnv)
    const credit = ctx.creditCosts.sales_strategy ?? 2
    const cacheDays = ctx.config.config.cache_days ?? 14
    const items: Record<string, StrategyItem> = { ...((ctx.progress.items as Record<string, StrategyItem> | undefined) ?? {}) }
    let tokensIn = Number(ctx.progress.tokens_input ?? 0)
    let tokensOut = Number(ctx.progress.tokens_output ?? 0)

    for (const t of targets) {
      const leadId = t.lead_id as string
      if (items[leadId]) continue
      const raw: LeadRaw | null = await ctx.tools.call('leads.read', { lead_id: leadId }, () => sales.getLead(ctx.orgId, leadId))
      if (!raw || raw.lead.deleted_at) {
        items[leadId] = { lead_id: leadId, company_name: null, status: 'skipped_not_found' }
        await ctx.checkpoint({ items, tokens_input: tokensIn, tokens_output: tokensOut })
        continue
      }
      const contactable = isContactable(raw)
      const evidence = await ctx.tools.call('evidence.read', { candidate_id: t.candidate_id }, () => ctx.store.listEvidence(ctx.orgId, 'candidate', t.candidate_id, 60))
      const stats: SanitizeStats = { flagged: 0 }
      const data = {
        profile: profileForModel(profile),
        lead: leadForModel(raw, stats),
        research: evidenceForModel(evidence, stats),
        memory: sanitizeDeep(memory.map((m) => ({ category: m.category, content: m.content })), 600, stats),
        objective: ctx.workflow.objective ? sanitizeUntrusted(ctx.workflow.objective, 500, stats) : null,
      }
      const inputHash = createHash('sha256').update(JSON.stringify({ data, tier: choice.effective, v: 1 })).digest('hex')

      // Cache per organizzazione e per lead: stessa richiesta recente → nessuna nuova chiamata né credito.
      const cached = await ctx.store.findRecentStrategy(ctx.orgId, leadId, inputHash, new Date(ctx.now().getTime() - cacheDays * 86_400_000).toISOString())
      if (cached) {
        items[leadId] = { lead_id: leadId, company_name: raw.lead.company_name, status: 'cached', contactable, strategy: cached, draft_id: (cached.draft_id as string | null) ?? null, warnings: (cached.warnings as Warning[]) ?? [] }
        await ctx.recordCost({ kind: 'ai_tokens', aiJobId: null, model: null, tokensInput: 0, tokensOutput: 0, credits: 0, costUsd: 0, cacheHit: true })
        await ctx.checkpoint({ items, tokens_input: tokensIn, tokens_output: tokensOut })
        continue
      }

      ctx.budget.reserve('strategy', credit)
      let jobId: string | null = null
      try {
        const result = await ctx.tools.call(
          'ai.generate_strategy',
          { lead_id: leadId, model_tier: choice.effective },
          async () => {
            jobId = await ctx.store.createAiJob({ org: ctx.orgId, type: 'sales_agent', task: 'sales_strategy', leadId, input: { workflow_id: ctx.workflow.id }, createdBy: ctx.userId })
            const res = await ai({
              system: [BASE_RULES, styleRules(profile.language, profile.tone), STRATEGY_TASK].join('\n\n'),
              user: buildUserPrompt(data, null, stats),
              schemaName: 'sales_strategy',
              schema: strategyJsonSchema,
              maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS.strategy,
            })
            const parsed = strategySchema.safeParse(res.json)
            if (!parsed.success) throw new AiError('ai_bad_response')
            return { res, o: parsed.data }
          },
          { summarizeResult: (r) => ({ tokens: r.res.usage.input_tokens + r.res.usage.output_tokens }) },
        )
        const { res, o } = result
        const ctxText = JSON.stringify(data)
        const allowed = allowedValues(profile, raw)
        const warnings: Warning[] = []
        const clean = (text: string, max?: number) => {
          const r = checkText(text, allowed, max)
          warnings.push(...r.warnings)
          return r.text
        }
        const service = profile.services.find((s) => s.id === o.recommended_service_id) ?? null
        if (o.recommended_service_id && !service) warnings.push({ code: 'unverified_fact', detail: 'recommended_service_not_in_catalog' })
        let opportunity = { statement: clean(o.opportunity.statement), basis: o.opportunity.basis, evidence: sanitizeUntrusted(o.opportunity.evidence, 600) }
        if (opportunity.basis === 'fact' && !factSupported(opportunity.evidence, ctxText)) {
          opportunity = { ...opportunity, basis: 'inference' }
          warnings.push({ code: 'unverified_fact', detail: o.opportunity.evidence.slice(0, 160) })
        }
        const strategy: Record<string, unknown> = {
          opportunity,
          recommended_service_id: service?.id ?? null,
          recommended_service_name: service?.name ?? null,
          service_rationale: clean(o.service_rationale),
          value_proposition: clean(o.value_proposition),
          objections: o.objections.map((x) => ({ objection: clean(x.objection), response: clean(x.response) })),
          approach: { channel: o.approach.channel, steps: o.approach.steps.map((s) => clean(s)) },
          call_to_action: clean(o.call_to_action || profile.callToAction || ''),
          assumptions: o.assumptions.map((a) => sanitizeUntrusted(a, 400)),
          missing_information: o.missing_information.map((m) => sanitizeUntrusted(m, 300)),
          untrusted_content_filtered: stats.flagged,
          generated_at: ctx.now().toISOString(),
          model: res.model,
        }
        let draftId: string | null = null
        if (o.draft && contactable) {
          const subject = clean(o.draft.subject, 200)
          const body = clean(o.draft.body, 2500)
          ;[draftId] = await ctx.tools.call('drafts.write', { lead_id: leadId, channel: 'email' }, () =>
            sales.insertDrafts(ctx.orgId, [
              {
                leadId,
                channel: 'email',
                variant: profile.tone === 'direct' ? 'direct' : profile.tone === 'consultative' ? 'consultative' : 'professional',
                generationId: randomUUID(),
                subject: subject.replace(/[\r\n]+/g, ' ').slice(0, 300),
                body: body.slice(0, 8000),
                factsUsed: opportunity.basis === 'fact' ? [{ fact: opportunity.statement.slice(0, 300), source: 'research.facts', verified: true }] : [],
                warnings: dedupeWarnings([...complianceWarnings('email', raw.source?.legal_basis ?? null), ...warnings]),
                aiJobId: jobId!,
                followUpTaskId: null,
                createdBy: ctx.userId,
              },
            ]),
          )
        } else if (o.draft && !contactable) {
          // Opposizione o non contattabilità: la bozza non viene salvata.
          strategy.draft_discarded = 'lead_not_contactable'
        }
        const finalWarnings = dedupeWarnings(warnings)
        strategy.draft_id = draftId
        strategy.warnings = finalWarnings
        const cost = estimateTierCost(res.usage, choice.effective, ctx.env)
        await ctx.store.finishAiJob(ctx.orgId, jobId!, { status: 'succeeded', model: res.model, tokensInput: res.usage.input_tokens, tokensOutput: res.usage.output_tokens, costUsd: cost, output: { input_hash: inputHash, strategy } })
        await sales.logActivity(ctx.orgId, leadId, ctx.userId, 'Strategia commerciale AI preparata (bozza, nessun invio)', { workflow_id: ctx.workflow.id, job_id: jobId })
        await ctx.recordCost({ kind: 'ai_tokens', aiJobId: jobId, model: res.model, tokensInput: res.usage.input_tokens, tokensOutput: res.usage.output_tokens, credits: credit, costUsd: cost, cacheHit: false })
        tokensIn += res.usage.input_tokens
        tokensOut += res.usage.output_tokens
        items[leadId] = { lead_id: leadId, company_name: raw.lead.company_name, status: 'generated', contactable, strategy, draft_id: draftId, warnings: finalWarnings }
      } catch (err) {
        ctx.budget.refund('strategy', credit)
        const e = toAgentError(err)
        // Prompt 10: token già consumati da una risposta scartata (troncata o rifiutata) → costo registrato
        // con 0 crediti per l'utente, così il monitoraggio dei costi AI non li perde.
        const lost = (e.opts.details as { usage?: { input_tokens: number; output_tokens: number } } | undefined)?.usage
        if (lost && lost.input_tokens + lost.output_tokens > 0) {
          await ctx.recordCost({ kind: 'ai_tokens', aiJobId: jobId, model: choice.model, tokensInput: lost.input_tokens, tokensOutput: lost.output_tokens, credits: 0, costUsd: estimateTierCost(lost, choice.effective, ctx.env), cacheHit: false }).catch(() => undefined)
          tokensIn += lost.input_tokens
          tokensOut += lost.output_tokens
        }
        if (jobId) await ctx.store.finishAiJob(ctx.orgId, jobId, { status: 'failed', error: e.code }).catch(() => undefined)
        // Budget, crediti, piano o tetti di spesa: il workflow si ferma; altri errori: solo questo lead fallisce.
        if (e.stopWorkflow || e.code === 'tool_denied') throw e
        items[leadId] = { lead_id: leadId, company_name: raw.lead.company_name, status: 'failed', error: e.code }
      }
      await ctx.checkpoint({ items, tokens_input: tokensIn, tokens_output: tokensOut })
    }

    const list = Object.values(items)
    const failed = list.filter((i) => i.status === 'failed').length
    return {
      output: {
        strategies: list,
        counts: {
          total: targets.length,
          generated: list.filter((i) => i.status === 'generated').length,
          cached: list.filter((i) => i.status === 'cached').length,
          failed,
          drafts: list.filter((i) => i.status === 'generated' && i.draft_id).length,
          not_contactable: list.filter((i) => i.contactable === false).length,
        },
        model_tier: choice.effective,
        model_fallback: choice.fallback,
        no_messages_sent: true,
      },
      itemsTotal: targets.length,
      itemsFailed: failed,
      model: choice.model,
      tokensInput: tokensIn,
      tokensOutput: tokensOut,
    }
  },
}
