import { randomUUID } from 'node:crypto'
import { HttpError } from '../http'
import { log } from '../log'
import { aiMissingConfig } from '../lead-finder/analysisService'
import { AiError, callStructured, openaiBaseUrl, type AiCallResult } from '../lead-finder/analysis/openai'
import { allowedValues, isContactable, leadForModel, profileForModel, profileMissing, type LeadRaw, type SalesProfile } from './context'
import { campaignChecks, checkText, dedupeWarnings, factSupported, type Warning } from './postcheck'
import { buildSystemPrompt, buildUserPrompt, TASK_PROMPTS } from './prompts'
import { sanitizeDeep, sanitizeUntrusted, type SanitizeStats } from './sanitize'
import { estimateCostUsd, MAX_OUTPUT_TOKENS } from './costs'
import {
  campaignContentJsonSchema,
  campaignContentSchema,
  copilotJsonSchema,
  copilotSchema,
  inboundAnalysisJsonSchema,
  inboundAnalysisSchema,
  followUpJsonSchema,
  followUpSchema,
  intelligenceJsonSchema,
  intelligenceSchema,
  messagesJsonSchema,
  messagesSchema,
  proposalJsonSchema,
  proposalSchema,
  VARIANTS,
} from './schemas'
import type { DraftWrite, SalesJob, SalesStore, SalesTask } from './store'

export interface Ctx {
  orgId: string
  userId: string
}

export type Channel = DraftWrite['channel']
export type Variant = DraftWrite['variant']

export type SalesTaskInput =
  | { task: 'intelligence'; lead_id: string; instructions?: string }
  | { task: 'messages'; lead_id: string; channel: Channel; instructions?: string }
  | { task: 'proposal'; lead_id: string; variant: Variant; instructions?: string }
  | { task: 'follow_up_suggestion'; follow_up_task_id: string }
  | { task: 'campaign_content'; campaign_id: string; position: number; instructions?: string }
  | { task: 'inbound_analysis'; inbound_id: string }

export type AiCaller = (p: { system: string; user: string; schemaName: string; schema: unknown; maxOutputTokens: number }) => Promise<AiCallResult>

export function defaultAiCaller(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): AiCaller {
  return (p) =>
    callStructured({ apiKey: env.OPENAI_API_KEY ?? '', model: env.OPENAI_MODEL ?? '', baseUrl: openaiBaseUrl(env), timeoutMs: 120_000, fetchImpl, ...p })
}

const CONTACT_TASKS = new Set(['messages', 'proposal', 'follow_up_suggestion'])
const CHANNEL_MAX: Record<Channel, number> = { email: 2500, linkedin: 1000, whatsapp: 700, phone_script: 3500, follow_up: 1200 }

// ════════════════════════════════════════════════════════════════════════════
// Controlli comuni (eseguiti dopo l'autorizzazione del chiamante)
// ════════════════════════════════════════════════════════════════════════════
async function guardAi(store: SalesStore, ctx: Ctx, env: NodeJS.ProcessEnv) {
  const missing = aiMissingConfig(env)
  if (missing.length) throw new HttpError(409, 'ai_not_configured', { missing })
  const rl = await store.checkRateLimit(ctx.orgId, ctx.userId, 'sales_agent')
  if (!rl.allowed) throw new HttpError(429, 'rate_limited', { retry_after: rl.retry_after ?? 60 })
  const [gen, tokens, inflight] = await Promise.all([
    store.consumeUsage(ctx.orgId, ctx.userId, 'ai_generation', 0),
    store.consumeUsage(ctx.orgId, ctx.userId, 'ai_tokens', 0),
    store.countInflight(ctx.orgId),
  ])
  if (gen.remaining - inflight <= 0) throw new HttpError(429, 'quota_ai_generations_exceeded', { used: gen.used, limit: gen.limit })
  if (tokens.remaining <= 0) throw new HttpError(429, 'quota_ai_tokens_exceeded', { used: tokens.used, limit: tokens.limit })
}

export async function requestSalesJob(deps: { store: SalesStore; env?: NodeJS.ProcessEnv }, ctx: Ctx, input: SalesTaskInput): Promise<{ job_id: string }> {
  const { store } = deps
  const env = deps.env ?? process.env
  await guardAi(store, ctx, env)

  if (input.task === 'campaign_content') {
    const c = await store.getCampaignForContent(ctx.orgId, input.campaign_id, input.position)
    if (!c) throw new HttpError(404, 'campaign_step_not_found')
    if (!['draft', 'pending_approval'].includes(c.campaign.status)) throw new HttpError(409, 'campaign_locked')
    if (!['email', 'follow_up_email'].includes(c.step.kind)) throw new HttpError(409, 'step_has_no_content')
    const missing = profileMissing(await store.getProfile(ctx.orgId))
    if (missing.length) throw new HttpError(409, 'sales_profile_incomplete', { missing })
    const jobId = await store.createJob({
      org: ctx.orgId,
      task: 'campaign_content',
      leadId: null,
      input: { task: 'campaign_content', campaign_id: input.campaign_id, position: input.position, ...(input.instructions ? { instructions: input.instructions.slice(0, 500) } : {}) },
      createdBy: ctx.userId,
    })
    return { job_id: jobId }
  }
  if (input.task === 'inbound_analysis') {
    const inbound = await store.getInbound(ctx.orgId, input.inbound_id)
    if (!inbound) throw new HttpError(404, 'inbound_not_found')
    const jobId = await store.createJob({ org: ctx.orgId, task: 'inbound_analysis', leadId: inbound.lead_id, input: { task: 'inbound_analysis', inbound_id: inbound.id }, createdBy: ctx.userId })
    return { job_id: jobId }
  }

  let leadId: string
  if (input.task === 'follow_up_suggestion') {
    const task = await store.getFollowUpTask(ctx.orgId, input.follow_up_task_id)
    if (!task) throw new HttpError(404, 'follow_up_not_found')
    if (task.status !== 'open') throw new HttpError(409, 'follow_up_not_open')
    leadId = task.lead_id
  } else {
    leadId = input.lead_id
  }
  const raw = await store.getLead(ctx.orgId, leadId)
  if (!raw || raw.lead.deleted_at) throw new HttpError(404, 'lead_not_found')
  if (CONTACT_TASKS.has(input.task) && !isContactable(raw)) throw new HttpError(409, 'lead_not_contactable')

  if (input.task !== 'follow_up_suggestion') {
    const missing = profileMissing(await store.getProfile(ctx.orgId))
    if (missing.length) throw new HttpError(409, 'sales_profile_incomplete', { missing })
  }

  const jobInput: Record<string, unknown> = { task: input.task }
  if ('channel' in input) jobInput.channel = input.channel
  if ('variant' in input) jobInput.variant = input.variant
  if ('instructions' in input && input.instructions) jobInput.instructions = input.instructions.slice(0, 500)
  if (input.task === 'follow_up_suggestion') jobInput.follow_up_task_id = input.follow_up_task_id
  const jobId = await store.createJob({ org: ctx.orgId, task: input.task, leadId, input: jobInput, createdBy: ctx.userId })
  return { job_id: jobId }
}

export async function requestCopilot(
  deps: { store: SalesStore; env?: NodeJS.ProcessEnv },
  ctx: Ctx,
  input: { conversation_id?: string; lead_id?: string; message: string },
): Promise<{ job_id: string; conversation_id: string; message_id: string }> {
  const { store } = deps
  await guardAi(store, ctx, deps.env ?? process.env)
  let conversationId = input.conversation_id
  if (conversationId) {
    const conv = await store.getConversation(ctx.orgId, conversationId)
    // Stessa risposta per conversazione inesistente o di un altro utente.
    if (!conv || conv.user_id !== ctx.userId || conv.archived_at) throw new HttpError(404, 'conversation_not_found')
  } else {
    if (input.lead_id) {
      const raw = await store.getLead(ctx.orgId, input.lead_id)
      if (!raw) throw new HttpError(404, 'lead_not_found')
    }
    conversationId = await store.createConversation(ctx.orgId, ctx.userId, input.message.slice(0, 80), input.lead_id ?? null)
  }
  const messageId = await store.insertUserMessage(ctx.orgId, conversationId, input.message)
  // Il job contiene solo riferimenti: il testo resta nella conversazione privata.
  const jobId = await store.createJob({ org: ctx.orgId, task: 'copilot', leadId: null, input: { task: 'copilot', conversation_id: conversationId, message_id: messageId }, createdBy: ctx.userId })
  return { job_id: jobId, conversation_id: conversationId, message_id: messageId }
}

// ════════════════════════════════════════════════════════════════════════════
// Verifiche comuni sull'output
// ════════════════════════════════════════════════════════════════════════════
export function complianceWarnings(channel: Channel | 'proposal', legalBasis: string | null): Warning[] {
  const w: Warning[] = []
  const strong = legalBasis === 'consent' || legalBasis === 'contract'
  if (!strong) w.push({ code: 'legal_basis_check_required', detail: legalBasis ?? 'unknown' })
  if (channel === 'whatsapp') w.push({ code: 'whatsapp_opt_in_required' })
  if (channel === 'phone_script') w.push({ code: 'check_opposition_registry' })
  return w
}

function verifyFacts(facts: { fact: string; source: string }[], contextText: string) {
  return facts.map((f) => ({ fact: f.fact, source: f.source, verified: factSupported(f.fact, contextText) }))
}

function factWarnings(facts: { fact: string; verified: boolean }[]): Warning[] {
  return facts.filter((f) => !f.verified).map((f) => ({ code: 'unverified_fact' as const, detail: f.fact.slice(0, 160) }))
}

function parseOrFail<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T {
  const r = schema.safeParse(value)
  if (!r.success) throw new AiError('ai_bad_response')
  return r.data
}

const toneVariant = (tone: SalesProfile['tone']): Variant => (tone === 'direct' ? 'direct' : tone === 'consultative' ? 'consultative' : 'professional')

interface HandlerResult {
  output: Record<string, unknown>
  usage: AiCallResult['usage']
  model: string
  activity?: string
}

// ════════════════════════════════════════════════════════════════════════════
// Gestori dei compiti
// ════════════════════════════════════════════════════════════════════════════
async function loadLeadAndProfile(store: SalesStore, job: SalesJob) {
  const [raw, profile] = await Promise.all([job.leadId ? store.getLead(job.organizationId, job.leadId) : null, store.getProfile(job.organizationId)])
  if (!raw) throw new HttpError(404, 'lead_not_found')
  return { raw, profile }
}

async function runIntelligence(store: SalesStore, ai: AiCaller, job: SalesJob): Promise<HandlerResult> {
  const { raw, profile } = await loadLeadAndProfile(store, job)
  const stats: SanitizeStats = { flagged: 0 }
  const data = { profile: profileForModel(profile), lead: leadForModel(raw, stats) }
  const res = await ai({
    system: buildSystemPrompt(TASK_PROMPTS.intelligence, profile.language, profile.tone),
    user: buildUserPrompt(data, (job.input.instructions as string) ?? null, stats),
    schemaName: 'lead_intelligence',
    schema: intelligenceJsonSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS.intelligence!,
  })
  const o = parseOrFail(intelligenceSchema, res.json)
  const ctxText = JSON.stringify(data)
  const verified = o.verified_data.filter((v) => factSupported(v.statement, ctxText))
  const demoted = o.verified_data.filter((v) => !factSupported(v.statement, ctxText)).map((v) => ({ statement: v.statement, rationale: 'Dato non trovato nelle fonti: trattato come ipotesi.' }))
  const service = profile.services.find((s) => s.id === o.recommended_service_id) ?? null
  let next = o.next_best_action
  if (!isContactable(raw) && (next.type === 'contact' || next.type === 'propose')) {
    next = { type: 'wait', description: 'Lead non contattabile: nessuna azione di contatto suggerita.' }
  }
  const data_ = {
    ...o,
    verified_data: verified,
    hypotheses: [...o.hypotheses, ...demoted].slice(0, 15),
    recommended_service_id: service?.id ?? null,
    recommended_service_name: service?.name ?? null,
    next_best_action: next,
    analyzed_at: new Date().toISOString(),
    model: res.model,
    untrusted_content_filtered: stats.flagged,
  }
  const id = await store.insertIntelligence(job.organizationId, raw.lead.id, data_, job.id, res.model)
  return { output: { analysis_id: id }, usage: res.usage, model: res.model, activity: 'Analisi commerciale AI completata' }
}

async function runMessages(store: SalesStore, ai: AiCaller, job: SalesJob, followUpTaskId: string | null = null): Promise<HandlerResult> {
  const { raw, profile } = await loadLeadAndProfile(store, job)
  if (!isContactable(raw)) throw new HttpError(409, 'lead_not_contactable')
  const channel = job.input.channel as Channel
  const stats: SanitizeStats = { flagged: 0 }
  const data = { profile: profileForModel(profile), lead: leadForModel(raw, stats), channel }
  const res = await ai({
    system: buildSystemPrompt(TASK_PROMPTS.messages(channel), profile.language, profile.tone),
    user: buildUserPrompt(data, (job.input.instructions as string) ?? null, stats),
    schemaName: 'message_variants',
    schema: messagesJsonSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS.messages!,
  })
  const o = parseOrFail(messagesSchema, res.json)
  if (new Set(o.variants.map((v) => v.variant)).size !== VARIANTS.length) throw new AiError('ai_bad_response')

  const ctxText = JSON.stringify(data)
  const allowed = allowedValues(profile, raw)
  const legal = complianceWarnings(channel, raw.source?.legal_basis ?? null)
  const generationId = randomUUID()
  const rows: DraftWrite[] = o.variants.map((v) => {
    const hasSubject = channel === 'email' || channel === 'follow_up'
    const subject = hasSubject && v.subject ? checkText(v.subject, allowed) : null
    const body = checkText(v.body, allowed, CHANNEL_MAX[channel])
    const facts = verifyFacts(v.personalization, ctxText)
    return {
      leadId: raw.lead.id,
      channel,
      variant: v.variant,
      generationId,
      subject: subject?.text.slice(0, 300) ?? null,
      body: body.text.slice(0, 8000),
      factsUsed: facts,
      warnings: dedupeWarnings([
        ...legal,
        ...(subject?.warnings ?? []),
        ...body.warnings,
        ...factWarnings(facts),
        ...(stats.flagged ? [{ code: 'untrusted_content_filtered' as const, detail: String(stats.flagged) }] : []),
      ]),
      aiJobId: job.id,
      followUpTaskId,
      createdBy: job.createdBy,
    }
  })
  const ids = await store.insertDrafts(job.organizationId, rows)
  return {
    output: { generation_id: generationId, draft_ids: ids, hypotheses_used: o.hypotheses_used },
    usage: res.usage,
    model: res.model,
    activity: `Bozze AI generate (${channel})`,
  }
}

async function runProposal(store: SalesStore, ai: AiCaller, job: SalesJob): Promise<HandlerResult> {
  const { raw, profile } = await loadLeadAndProfile(store, job)
  if (!isContactable(raw)) throw new HttpError(409, 'lead_not_contactable')
  const variant = (job.input.variant as Variant) ?? 'consultative'
  const stats: SanitizeStats = { flagged: 0 }
  const data = { profile: profileForModel(profile), lead: leadForModel(raw, stats), proposal_style: variant }
  const res = await ai({
    system: buildSystemPrompt(TASK_PROMPTS.proposal, profile.language, profile.tone),
    user: buildUserPrompt(data, (job.input.instructions as string) ?? null, stats),
    schemaName: 'commercial_proposal',
    schema: proposalJsonSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS.proposal!,
  })
  const o = parseOrFail(proposalSchema, res.json)
  const allowed = allowedValues(profile, raw)
  // I prezzi vengono solo dal listino configurato, mai dal modello.
  const selected = profile.services.filter((s) => o.selected_service_ids.includes(s.id))
  const pricing = {
    currency: profile.currency,
    lines: selected.map((s) => ({ service_id: s.id, name: s.name, price_from: s.price_from ?? null, price_to: s.price_to ?? null, price_unit: s.price_unit ?? null })),
    price_range: profile.priceRange,
  }
  const warnings: Warning[] = [...complianceWarnings('proposal', raw.source?.legal_basis ?? null)]
  const clean = (t: string) => {
    const r = checkText(t, allowed)
    warnings.push(...r.warnings)
    return r.text
  }
  const content = {
    company_presentation: clean(o.company_presentation),
    opportunity: { statement: clean(o.opportunity.statement), basis: o.opportunity.basis, evidence: o.opportunity.evidence },
    solution: clean(o.solution),
    services_included: o.services_included.map(clean),
    benefits: o.benefits.map(clean),
    pricing,
    conditions: profile.commercialTerms ?? '',
    call_to_action: clean(o.call_to_action || profile.callToAction || ''),
    assumptions: o.assumptions,
  }
  if (!profile.commercialTerms) warnings.push({ code: 'no_commercial_terms' })
  if (o.opportunity.basis === 'verified' && !factSupported(o.opportunity.evidence, JSON.stringify(data))) {
    content.opportunity.basis = 'hypothesis'
    warnings.push({ code: 'unverified_fact', detail: o.opportunity.evidence.slice(0, 160) })
  }
  const facts = verifyFacts(o.facts_used, JSON.stringify(data))
  warnings.push(...factWarnings(facts))
  if (stats.flagged) warnings.push({ code: 'untrusted_content_filtered', detail: String(stats.flagged) })
  const id = await store.insertProposal(job.organizationId, {
    leadId: raw.lead.id,
    title: sanitizeUntrusted(o.title, 200),
    variant,
    language: profile.language,
    content,
    factsUsed: facts,
    warnings: dedupeWarnings(warnings),
    aiJobId: job.id,
    createdBy: job.createdBy,
  })
  return { output: { proposal_id: id }, usage: res.usage, model: res.model }
}

async function runFollowUp(store: SalesStore, ai: AiCaller, job: SalesJob): Promise<HandlerResult> {
  const taskId = job.input.follow_up_task_id as string
  const task = await store.getFollowUpTask(job.organizationId, taskId)
  if (!task || task.status !== 'open') throw new HttpError(409, 'follow_up_not_open')
  const { raw, profile } = await loadLeadAndProfile(store, job)
  const isContact = task.kind !== 'opportunity_review'
  if (isContact && !isContactable(raw)) throw new HttpError(409, 'lead_not_contactable')
  const stats: SanitizeStats = { flagged: 0 }
  const data = {
    profile: profileForModel(profile),
    lead: leadForModel(raw, stats),
    task: sanitizeDeep({ kind: task.kind, title: task.title, due_at: task.due_at, notes: task.notes, requires_contact: isContact }, 1000, stats),
  }
  const res = await ai({
    system: buildSystemPrompt(TASK_PROMPTS.follow_up, profile.language, profile.tone),
    user: buildUserPrompt(data, null, stats),
    schemaName: 'follow_up_suggestion',
    schema: followUpJsonSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS.follow_up_suggestion!,
  })
  const o = parseOrFail(followUpSchema, res.json)
  let draftId: string | null = null
  if (o.message && isContact) {
    const allowed = allowedValues(profile, raw)
    const subject = o.message.subject ? checkText(o.message.subject, allowed) : null
    const body = checkText(o.message.body, allowed, CHANNEL_MAX.follow_up)
    ;[draftId] = await store.insertDrafts(job.organizationId, [
      {
        leadId: raw.lead.id,
        channel: 'follow_up',
        variant: toneVariant(profile.tone),
        generationId: randomUUID(),
        subject: subject?.text ?? null,
        body: body.text,
        factsUsed: [],
        warnings: dedupeWarnings([...complianceWarnings('follow_up', raw.source?.legal_basis ?? null), ...(subject?.warnings ?? []), ...body.warnings]),
        aiJobId: job.id,
        followUpTaskId: task.id,
        createdBy: job.createdBy,
      },
    ])
  }
  await store.setFollowUpSuggestion(job.organizationId, task.id, {
    suggestion: o.suggestion,
    reasoning: o.reasoning,
    timing_note: o.timing_note,
    draft_id: draftId,
    model: res.model,
    generated_at: new Date().toISOString(),
  })
  return { output: { follow_up_task_id: task.id, draft_id: draftId }, usage: res.usage, model: res.model, activity: 'Suggerimento AI per follow-up' }
}

async function runCopilot(store: SalesStore, ai: AiCaller, job: SalesJob): Promise<HandlerResult> {
  const convId = job.input.conversation_id as string
  const messageId = job.input.message_id as string
  const conv = await store.getConversation(job.organizationId, convId)
  if (!conv || conv.user_id !== job.createdBy) throw new HttpError(404, 'conversation_not_found')
  const history = await store.getConversationMessages(job.organizationId, convId, 12)
  const question = history.find((m) => m.id === messageId)
  if (!question) throw new HttpError(404, 'message_not_found')
  const [profile, snapshotRaw, focus] = await Promise.all([
    store.getProfile(job.organizationId),
    store.getCopilotSnapshot(job.organizationId),
    conv.lead_id ? store.getLead(job.organizationId, conv.lead_id) : Promise.resolve(null),
  ])
  const stats: SanitizeStats = { flagged: 0 }
  const snapshot = sanitizeDeep(snapshotRaw, 300, stats)
  const data = {
    profile: { commercial_name: profile.commercialName, services: profile.services.map((s) => s.name), ideal_customer: profile.idealCustomer },
    snapshot,
    focus_lead: focus ? leadForModel(focus, stats) : null,
    conversation: history.filter((m) => m.id !== messageId).slice(-8).map((m) => ({ role: m.role, content: sanitizeUntrusted(m.content, 1200, stats) })),
    question: sanitizeUntrusted(question.content, 1000, stats),
  }
  const res = await ai({
    system: buildSystemPrompt(TASK_PROMPTS.copilot, profile.language, 'consultative'),
    user: buildUserPrompt(data, null, stats),
    schemaName: 'copilot_answer',
    schema: copilotJsonSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS.copilot!,
  })
  const o = parseOrFail(copilotSchema, res.json)
  // Solo riferimenti a lead realmente presenti nei dati dell'organizzazione.
  const known = new Set([...snapshotRaw.leads.map((l) => l.id), ...(focus ? [focus.lead.id] : [])])
  const contactable = new Map(snapshotRaw.leads.map((l) => [l.id, l.contactable]))
  if (focus) contactable.set(focus.lead.id, isContactable(focus))
  const allowed = allowedValues(profile, focus)
  const clean = (t: string) => checkText(t, allowed).text
  const structured = {
    facts: o.facts.map((f) => ({ statement: clean(f.statement), lead_ids: f.lead_ids.filter((id) => known.has(id)) })),
    inferences: o.inferences.map((f) => ({ statement: clean(f.statement), lead_ids: f.lead_ids.filter((id) => known.has(id)) })),
    suggestions: o.suggestions
      .map((s) => {
        const leadId = s.lead_id && known.has(s.lead_id) ? s.lead_id : null
        let action = leadId || s.action === 'none' ? s.action : 'none'
        // Nessun suggerimento di contatto per lead non contattabili.
        if (leadId && contactable.get(leadId) === false && ['generate_messages', 'generate_proposal', 'create_follow_up'].includes(action)) action = 'open_lead'
        return { statement: clean(s.statement), lead_id: leadId, action }
      }),
    untrusted_content_filtered: stats.flagged,
  }
  const answerId = await store.insertAssistantMessage(job.organizationId, convId, {
    content: clean(o.answer).slice(0, 8000),
    structured,
    jobId: job.id,
    model: res.model,
    tokensInput: res.usage.input_tokens,
    tokensOutput: res.usage.output_tokens,
  })
  return { output: { conversation_id: convId, message_id: answerId }, usage: res.usage, model: res.model }
}

async function runCampaignContent(store: SalesStore, ai: AiCaller, job: SalesJob): Promise<HandlerResult> {
  const c = await store.getCampaignForContent(job.organizationId, String(job.input.campaign_id), Number(job.input.position))
  if (!c) throw new HttpError(404, 'campaign_step_not_found')
  if (!['draft', 'pending_approval'].includes(c.campaign.status)) throw new HttpError(409, 'campaign_locked')
  const profile = await store.getProfile(job.organizationId)
  const stats: SanitizeStats = { flagged: 0 }
  const language = c.campaign.language
  const data = {
    profile: profileForModel(profile),
    campaign: sanitizeDeep({ name: c.campaign.name, description: c.campaign.description, goal: c.campaign.goal, service: c.campaign.service_name, call_to_action: c.campaign.call_to_action ?? profile.callToAction }, 600, stats),
    step: { type: c.step.kind === 'email' ? 'initial' : 'follow_up', day_offset: c.step.day_offset },
    // Solo dati aggregati: nessun dato personale dei destinatari arriva al modello.
    audience: sanitizeDeep(c.audience, 120, stats),
  }
  const res = await ai({
    system: buildSystemPrompt(TASK_PROMPTS.campaign_content, language, profile.tone),
    user: buildUserPrompt(data, (job.input.instructions as string) ?? null, stats),
    schemaName: 'campaign_content',
    schema: campaignContentJsonSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS.campaign_content!,
  })
  const o = parseOrFail(campaignContentSchema, res.json)
  if (new Set(o.variants.map((v) => v.variant)).size !== VARIANTS.length) throw new AiError('ai_bad_response')
  const allowed = allowedValues(profile, null)
  const all: Warning[] = []
  const variants = o.variants.map((v) => {
    const subject = checkText(v.subject, allowed, 120)
    const body = checkText(v.body, allowed, 1800)
    const cta = checkText(v.call_to_action, allowed)
    const warnings = dedupeWarnings([...subject.warnings, ...body.warnings, ...campaignChecks(`${subject.text}\n${body.text}\n${cta.text}`)])
    all.push(...warnings)
    return { variant: v.variant, subject: subject.text.replace(/[\r\n]+/g, ' ').slice(0, 200), body: body.text.slice(0, 6000), call_to_action: cta.text.slice(0, 300), warnings }
  })
  if (stats.flagged) all.push({ code: 'untrusted_content_filtered', detail: String(stats.flagged) })
  await store.saveStepVariants(job.organizationId, c.step.id, variants, dedupeWarnings(all), job.id)
  return { output: { campaign_id: c.campaign.id, step_id: c.step.id, notes: sanitizeUntrusted(o.notes, 800) }, usage: res.usage, model: res.model }
}

async function runInboundAnalysis(store: SalesStore, ai: AiCaller, job: SalesJob): Promise<HandlerResult> {
  const inbound = await store.getInbound(job.organizationId, String(job.input.inbound_id))
  if (!inbound) throw new HttpError(404, 'inbound_not_found')
  const profile = await store.getProfile(job.organizationId)
  const raw = inbound.lead_id ? await store.getLead(job.organizationId, inbound.lead_id) : null
  const stats: SanitizeStats = { flagged: 0 }
  const data = {
    profile: profileForModel(profile),
    lead: raw ? leadForModel(raw, stats) : null,
    original_message: inbound.original ? sanitizeDeep(inbound.original, 2000, stats) : null,
    inbound: { subject: sanitizeUntrusted(inbound.subject ?? '', 300, stats), body: sanitizeUntrusted(inbound.body_text ?? '', 6000, stats), received_at: inbound.received_at },
  }
  const res = await ai({
    system: buildSystemPrompt(TASK_PROMPTS.inbound_analysis, profile.language, profile.tone),
    user: buildUserPrompt(data, null, stats),
    schemaName: 'inbound_analysis',
    schema: inboundAnalysisJsonSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS.inbound_analysis!,
  })
  const o = parseOrFail(inboundAnalysisSchema, res.json)
  // Nessuna bozza di risposta a chi si è opposto o ha chiesto la disiscrizione.
  const canReply = o.classification !== 'unsubscribe' && o.classification !== 'out_of_office' && (!raw || isContactable(raw))
  const reply = canReply && o.suggested_reply ? checkText(o.suggested_reply.body, allowedValues(profile, raw)).text.slice(0, 4000) : null
  await store.saveInboundAnalysis(job.organizationId, inbound.id, {
    classification: o.classification,
    summary: sanitizeUntrusted(o.summary, 1500),
    suggested_reply: reply,
    needs_human: o.needs_human || o.classification === 'needs_human',
    jobId: job.id,
  })
  return { output: { inbound_id: inbound.id, classification: o.classification }, usage: res.usage, model: res.model }
}

// ════════════════════════════════════════════════════════════════════════════
// Esecuzione dei job (background function)
// ════════════════════════════════════════════════════════════════════════════
export async function runSalesJob(
  deps: { store: SalesStore; env?: NodeJS.ProcessEnv; ai?: AiCaller },
  jobId: string,
): Promise<'succeeded' | 'failed' | 'skipped'> {
  const { store } = deps
  const env = deps.env ?? process.env
  const ai = deps.ai ?? defaultAiCaller(env)
  const job = await store.getJob(jobId)
  if (!job || job.status !== 'queued') return 'skipped'
  const org = job.organizationId
  await store.updateJob(org, jobId, { status: 'running', startedAt: new Date().toISOString() })
  const started = Date.now()
  try {
    const handlers: Record<SalesTask, () => Promise<HandlerResult>> = {
      intelligence: () => runIntelligence(store, ai, job),
      messages: () => runMessages(store, ai, job),
      proposal: () => runProposal(store, ai, job),
      follow_up_suggestion: () => runFollowUp(store, ai, job),
      copilot: () => runCopilot(store, ai, job),
      campaign_content: () => runCampaignContent(store, ai, job),
      inbound_analysis: () => runInboundAnalysis(store, ai, job),
    }
    const handler = handlers[job.task]
    if (!handler) throw new HttpError(400, 'unknown_task')
    const r = await handler()
    const tokens = r.usage.input_tokens + r.usage.output_tokens
    const cost = estimateCostUsd(r.usage, env)
    const user = job.createdBy ?? '00000000-0000-0000-0000-000000000000'
    // Crediti consumati solo a generazione riuscita.
    await store.consumeUsage(org, user, 'ai_generation', 1, { job_id: jobId, task: job.task })
    if (tokens > 0) await store.consumeUsage(org, user, 'ai_tokens', tokens, { job_id: jobId })
    await store.updateJob(org, jobId, {
      status: 'succeeded',
      output: r.output,
      model: r.model,
      tokensInput: r.usage.input_tokens,
      tokensOutput: r.usage.output_tokens,
      costUsd: cost,
      completedAt: new Date().toISOString(),
    })
    if (r.activity && job.leadId) await store.logActivity(org, job.leadId, job.createdBy, r.activity, { job_id: jobId, task: job.task })
    log('info', 'sales_job.succeeded', { job_id: jobId, task: job.task, ms: Date.now() - started, tokens_in: r.usage.input_tokens, tokens_out: r.usage.output_tokens, cost_usd: cost })
    return 'succeeded'
  } catch (err) {
    const code = err instanceof AiError || err instanceof HttpError ? err.code : 'internal_error'
    log('warn', 'sales_job.failed', { job_id: jobId, task: job.task, code, ms: Date.now() - started })
    await store.updateJob(org, jobId, { status: 'failed', error: code, completedAt: new Date().toISOString() }).catch(() => undefined)
    return 'failed'
  }
}
