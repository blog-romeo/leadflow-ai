import { z } from 'zod'
import type { AgentKey, RunStatus, StepAction } from './types'

/**
 * Agent Collaboration Engine (Prompt 9) — contratto tipizzato tra gli agenti.
 *
 * Ogni esecuzione di un agente produce un ENVELOPE JSON validato con zod, salvato in
 * ai_agent_runs.output. Gli agenti successivi leggono solo l'output validato del passo precedente
 * (ai_workflow_steps.output), mai testo libero: se l'output di un agente non rispetta lo schema
 * della sua azione, il passo fallisce con `invalid_agent_output` (errore permanente, nessun retry,
 * quindi nessun credito consumato due volte) e i passi dipendenti vengono saltati.
 *
 * Gli schemi controllano i campi da cui dipendono gli agenti successivi e l'interfaccia; i campi
 * aggiuntivi sono ammessi (passthrough) per non rompere la compatibilità con i dati già salvati.
 */
export const ENVELOPE_VERSION = 1

const count = z.number().int().min(0)
const uuidLike = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const counts = (keys: string[]) => z.object(Object.fromEntries(keys.map((k) => [k, count]))).passthrough()
const basis = z.enum(['fact', 'inference', 'unknown'])

export const ACTION_OUTPUT_SCHEMAS: Record<StepAction, z.ZodType> = {
  discover: z
    .object({
      done: z.literal(true),
      provider: z.string().min(2).max(40),
      search_id: z.string().min(1).max(80),
      candidate_ids: z.array(uuidLike).max(500),
      counts: counts(['total', 'found', 'new', 'kept']),
    })
    .passthrough(),
  research: z
    .object({
      counts: counts(['total', 'analyzed', 'cached', 'failed', 'facts', 'inferences', 'unknowns']),
      results: z.record(z.string(), z.string()),
    })
    .passthrough(),
  score: z
    .object({
      ranked: z
        .array(
          z
            .object({
              candidate_id: uuidLike,
              score: z.number().min(0).max(100),
              priority: z.enum(['high', 'medium', 'low']),
              missing: z.array(z.string()),
            })
            .passthrough(),
        )
        .max(500),
      eligible_ids: z.array(uuidLike).max(500),
      counts: counts(['total', 'eligible', 'high', 'medium', 'low']),
      measure: z.literal('compatibility_index'),
    })
    .passthrough(),
  'crm.save_leads': z
    .object({
      lead_ids: z.array(uuidLike).max(500),
      counts: counts(['total', 'saved', 'already_saved']),
    })
    .passthrough(),
  strategy: z
    .object({
      strategies: z
        .array(
          z
            .object({
              lead_id: uuidLike,
              status: z.enum(['generated', 'cached', 'failed', 'skipped_not_found']),
              strategy: z
                .object({ opportunity: z.object({ statement: z.string(), basis, evidence: z.string().nullable().optional() }).passthrough() })
                .passthrough()
                .optional(),
            })
            .passthrough(),
        )
        .max(50),
      counts: counts(['total', 'generated', 'cached', 'failed']),
      no_messages_sent: z.literal(true),
    })
    .passthrough(),
  'follow_up.analyze': z
    .object({
      proposal: z.object({ create: z.array(z.unknown()), block: z.array(z.unknown()) }).passthrough(),
      counts: counts(['total', 'to_create', 'to_block']),
    })
    .passthrough(),
  'follow_up.apply': z
    .object({
      created_task_ids: z.array(z.string()),
      counts: counts(['total', 'created']),
      no_messages_sent: z.literal(true),
    })
    .passthrough(),
  'growth.analyze': z
    .object({
      period: z.object({ from: z.string(), to: z.string(), days: count }).passthrough(),
      metrics: z.record(z.string(), z.unknown()),
      insights: z.array(z.unknown()),
      data_gaps: z.array(z.string()),
    })
    .passthrough(),
}

export interface EvidenceSummary {
  /** L'azione deve produrre evidenze verificabili (FACT/INFERENCE/UNKNOWN). */
  required: boolean
  facts: number
  inferences: number
  unknowns: number
  /** Elementi (aziende, lead) con almeno un'evidenza. */
  items_with_evidence: number
  items_total: number
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Riepilogo delle evidenze ricavato dall'output validato (nessun testo generato). */
export function evidenceSummary(action: StepAction, output: Record<string, unknown>): EvidenceSummary {
  const c = asObj(output.counts)
  if (action === 'research') {
    const analyzed = num(c.analyzed) + num(c.cached)
    return { required: true, facts: num(c.facts), inferences: num(c.inferences), unknowns: num(c.unknowns), items_with_evidence: analyzed, items_total: num(c.total) }
  }
  if (action === 'score') {
    const ranked = Array.isArray(output.ranked) ? (output.ranked as Record<string, unknown>[]) : []
    const withEv = ranked.filter((r) => Array.isArray(r.evidence) && (r.evidence as unknown[]).length > 0).length
    return { required: true, facts: 0, inferences: 0, unknowns: 0, items_with_evidence: withEv, items_total: ranked.length }
  }
  if (action === 'strategy') {
    const list = Array.isArray(output.strategies) ? (output.strategies as Record<string, unknown>[]) : []
    let facts = 0
    let inferences = 0
    let unknowns = 0
    let withEv = 0
    for (const it of list) {
      const opp = asObj(asObj(it.strategy).opportunity)
      if (opp.basis === 'fact') facts++
      else if (opp.basis === 'inference') inferences++
      else if (opp.basis === 'unknown') unknowns++
      if (opp.basis === 'fact' && typeof opp.evidence === 'string' && opp.evidence.trim()) withEv++
    }
    return { required: true, facts, inferences, unknowns, items_with_evidence: withEv, items_total: list.length }
  }
  return { required: false, facts: 0, inferences: 0, unknowns: 0, items_with_evidence: 0, items_total: 0 }
}

/** Codici di errore dei singoli elementi (senza testo libero). */
export function itemErrors(output: Record<string, unknown>): { code: string; count: number }[] {
  const codes: Record<string, number> = {}
  const push = (c: unknown) => {
    if (typeof c === 'string' && /^[a-z0-9_]{2,80}$/.test(c)) codes[c] = (codes[c] ?? 0) + 1
  }
  for (const it of Array.isArray(output.strategies) ? (output.strategies as Record<string, unknown>[]) : []) if (it.status === 'failed') push(it.error)
  for (const [, v] of Object.entries(asObj(output.results))) if (v === 'failed') push('item_failed')
  return Object.entries(codes).map(([code, n]) => ({ code, count: n }))
}

export const agentRunEnvelopeSchema = z
  .object({
    envelope_version: z.literal(ENVELOPE_VERSION),
    workflow_id: uuidLike,
    organization_id: uuidLike,
    run_id: uuidLike,
    agent_key: z.string(),
    action: z.string(),
    step_position: z.number().int().min(1),
    attempt: z.number().int().min(1),
    status: z.enum(['succeeded', 'partial', 'failed', 'cancelled', 'timed_out']),
    input: z.object({ params: z.record(z.string(), z.unknown()), depends_on: z.array(z.number().int()), approval_id: z.string().nullable() }),
    output: z.record(z.string(), z.unknown()).nullable(),
    output_valid: z.boolean(),
    evidence: z.object({ required: z.boolean(), facts: count, inferences: count, unknowns: count, items_with_evidence: count, items_total: count }),
    errors: z.array(z.object({ code: z.string(), count: z.number().int().min(1) })),
    usage: z.object({ tokens_input: count, tokens_output: count, credits: count, cost_usd: z.number().min(0).nullable() }),
    routing: z.object({ model: z.string().nullable(), tier: z.string().nullable(), fallback: z.boolean() }).nullable(),
    // Prompt 12: esito del Quality Reviewer (solo conteggi per codice).
    review: z.object({ checked: count, findings: z.record(z.string(), count), blocking: count }).nullable(),
    items: z.object({ total: count, failed: count }),
    duration_ms: count,
    started_at: z.string(),
    completed_at: z.string(),
  })
  .strict()

export type AgentRunEnvelope = z.infer<typeof agentRunEnvelopeSchema>

export function validateActionOutput(action: StepAction, output: unknown): { ok: true } | { ok: false; issues: string[] } {
  const schema = ACTION_OUTPUT_SCHEMAS[action]
  if (!schema) return { ok: false, issues: ['unknown_action'] }
  const r = schema.safeParse(output)
  if (r.success) return { ok: true }
  return { ok: false, issues: r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}:${i.code}`) }
}

/** Oltre questa dimensione l'output completo resta solo in ai_workflow_steps.output (limite del DB: 256 KB). */
const MAX_ENVELOPE_OUTPUT_BYTES = 180_000

export function buildEnvelope(a: {
  workflowId: string
  organizationId: string
  runId: string
  agentKey: AgentKey
  action: StepAction
  position: number
  attempt: number
  status: Exclude<RunStatus, 'running'>
  params: Record<string, unknown>
  dependsOn: number[]
  approvalId: string | null
  output: Record<string, unknown> | null
  outputValid: boolean
  errorCode: string | null
  tokensInput: number
  tokensOutput: number
  credits: number
  costUsd: number | null
  model: string | null
  tier: string | null
  fallback: boolean
  itemsTotal: number
  itemsFailed: number
  startedAt: Date
  completedAt: Date
}): AgentRunEnvelope {
  const out = a.output
  let stored: Record<string, unknown> | null = out
  if (out && JSON.stringify(out).length > MAX_ENVELOPE_OUTPUT_BYTES) stored = { truncated: true, full_output: 'ai_workflow_steps.output' }
  const errors = out ? itemErrors(out) : []
  if (a.errorCode) errors.unshift({ code: a.errorCode, count: 1 })
  const env: AgentRunEnvelope = {
    envelope_version: ENVELOPE_VERSION,
    workflow_id: a.workflowId,
    organization_id: a.organizationId,
    run_id: a.runId,
    agent_key: a.agentKey,
    action: a.action,
    step_position: a.position,
    attempt: a.attempt,
    status: a.status,
    // Solo parametri strutturati del workflow (già validati da zod all'avvio), nessun contenuto esterno.
    input: { params: a.params, depends_on: a.dependsOn, approval_id: a.approvalId },
    output: stored,
    output_valid: a.outputValid,
    evidence: out && a.outputValid ? evidenceSummary(a.action, out) : { required: false, facts: 0, inferences: 0, unknowns: 0, items_with_evidence: 0, items_total: 0 },
    errors,
    usage: { tokens_input: Math.max(0, Math.floor(a.tokensInput)), tokens_output: Math.max(0, Math.floor(a.tokensOutput)), credits: Math.max(0, Math.floor(a.credits)), cost_usd: a.costUsd },
    routing: a.model || a.tier ? { model: a.model, tier: a.tier, fallback: a.fallback } : null,
    review: (() => {
      const r = out?.review as { checked?: number; findings?: Record<string, number>; blocking?: number } | undefined
      return r && typeof r.checked === 'number' ? { checked: r.checked, findings: r.findings ?? {}, blocking: r.blocking ?? 0 } : null
    })(),
    items: { total: Math.max(0, a.itemsTotal), failed: Math.max(0, a.itemsFailed) },
    duration_ms: Math.max(0, a.completedAt.getTime() - a.startedAt.getTime()),
    started_at: a.startedAt.toISOString(),
    completed_at: a.completedAt.toISOString(),
  }
  // L'envelope stesso è validato: un difetto del motore non salva un record malformato e non interrompe
  // l'esecuzione (che deve comunque registrare l'esito e rilasciare il lease).
  const checked = agentRunEnvelopeSchema.safeParse(env)
  if (checked.success) return checked.data
  return { ...env, output: null, output_valid: false, errors: [{ code: 'envelope_invalid', count: 1 }, ...env.errors] }
}
