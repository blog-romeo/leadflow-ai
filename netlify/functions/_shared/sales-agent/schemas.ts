import { z } from 'zod'

/**
 * Schemi di output per OpenAI Structured Outputs (JSON Schema "strict") e la
 * corrispondente validazione zod lato server. Ogni risposta separa dati verificati,
 * ipotesi e suggerimenti.
 */
const S = { type: 'string' } as const
const NS = { type: ['string', 'null'] } as const
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const arr = (items: unknown) => ({ type: 'array', items })
const enm = (values: readonly string[]) => ({ type: 'string', enum: [...values] })

const sourceRef = z.string().max(120)
const short = (n: number) => z.string().max(n)

// ── Lead intelligence ──────────────────────────────────────────────────────
export const NEXT_ACTIONS = ['qualify', 'research', 'contact', 'propose', 'wait', 'close'] as const
export const intelligenceSchema = z.object({
  fit_summary: short(1200),
  verified_data: z.array(z.object({ statement: short(400), source: sourceRef })).max(15),
  hypotheses: z.array(z.object({ statement: short(400), rationale: short(400) })).max(10),
  opportunities: z.array(z.object({ title: short(200), rationale: short(500), basis: z.enum(['verified', 'hypothesis']) })).max(6),
  recommended_service_id: z.string().max(40).nullable(),
  recommended_service_reason: short(600),
  commercial_rationale: short(1500),
  operational_priority: z.enum(['high', 'medium', 'low']),
  priority_reason: short(600),
  missing_information: z.array(short(200)).max(12),
  next_best_action: z.object({ type: z.enum(NEXT_ACTIONS), description: short(400) }),
})
export type Intelligence = z.infer<typeof intelligenceSchema>
export const intelligenceJsonSchema = obj({
  fit_summary: S,
  verified_data: arr(obj({ statement: S, source: S })),
  hypotheses: arr(obj({ statement: S, rationale: S })),
  opportunities: arr(obj({ title: S, rationale: S, basis: enm(['verified', 'hypothesis']) })),
  recommended_service_id: NS,
  recommended_service_reason: S,
  commercial_rationale: S,
  operational_priority: enm(['high', 'medium', 'low']),
  priority_reason: S,
  missing_information: arr(S),
  next_best_action: obj({ type: enm(NEXT_ACTIONS), description: S }),
})

// ── Messaggi: tre varianti ─────────────────────────────────────────────────
export const VARIANTS = ['professional', 'direct', 'consultative'] as const
export const messagesSchema = z.object({
  variants: z
    .array(
      z.object({
        variant: z.enum(VARIANTS),
        subject: z.string().max(300).nullable(),
        body: z.string().min(1).max(6000),
        personalization: z.array(z.object({ fact: short(300), source: sourceRef })).max(8),
      }),
    )
    .length(3),
  hypotheses_used: z.array(short(300)).max(8),
})
export type MessagesOutput = z.infer<typeof messagesSchema>
export const messagesJsonSchema = obj({
  variants: arr(obj({ variant: enm(VARIANTS), subject: NS, body: S, personalization: arr(obj({ fact: S, source: S })) })),
  hypotheses_used: arr(S),
})

// ── Proposta commerciale ───────────────────────────────────────────────────
export const proposalSchema = z.object({
  title: z.string().min(2).max(200),
  company_presentation: short(2000),
  opportunity: z.object({ statement: short(1500), basis: z.enum(['verified', 'hypothesis']), evidence: short(400) }),
  solution: short(3000),
  selected_service_ids: z.array(z.string().max(40)).max(10),
  services_included: z.array(short(300)).max(15),
  benefits: z.array(short(400)).max(8),
  call_to_action: short(400),
  facts_used: z.array(z.object({ fact: short(300), source: sourceRef })).max(10),
  assumptions: z.array(short(300)).max(8),
})
export type ProposalOutput = z.infer<typeof proposalSchema>
export const proposalJsonSchema = obj({
  title: S,
  company_presentation: S,
  opportunity: obj({ statement: S, basis: enm(['verified', 'hypothesis']), evidence: S }),
  solution: S,
  selected_service_ids: arr(S),
  services_included: arr(S),
  benefits: arr(S),
  call_to_action: S,
  facts_used: arr(obj({ fact: S, source: S })),
  assumptions: arr(S),
})

// ── Suggerimento di follow-up ──────────────────────────────────────────────
export const followUpSchema = z.object({
  suggestion: short(800),
  reasoning: short(800),
  timing_note: short(300),
  message: z.object({ subject: z.string().max(300).nullable(), body: z.string().min(1).max(3000) }).nullable(),
})
export type FollowUpOutput = z.infer<typeof followUpSchema>
export const followUpJsonSchema = obj({
  suggestion: S,
  reasoning: S,
  timing_note: S,
  message: { anyOf: [obj({ subject: NS, body: S }), { type: 'null' }] },
})

// ── Copilota ───────────────────────────────────────────────────────────────
export const COPILOT_ACTIONS = ['none', 'open_lead', 'generate_messages', 'generate_proposal', 'create_follow_up'] as const
const refs = z.array(z.string().max(40)).max(10)
export const copilotSchema = z.object({
  answer: z.string().min(1).max(3000),
  facts: z.array(z.object({ statement: short(500), lead_ids: refs })).max(15),
  inferences: z.array(z.object({ statement: short(500), lead_ids: refs })).max(10),
  suggestions: z.array(z.object({ statement: short(500), lead_id: z.string().max(40).nullable(), action: z.enum(COPILOT_ACTIONS) })).max(8),
})
export type CopilotOutput = z.infer<typeof copilotSchema>
export const copilotJsonSchema = obj({
  answer: S,
  facts: arr(obj({ statement: S, lead_ids: arr(S) })),
  inferences: arr(obj({ statement: S, lead_ids: arr(S) })),
  suggestions: arr(obj({ statement: S, lead_id: NS, action: enm(COPILOT_ACTIONS) })),
})
