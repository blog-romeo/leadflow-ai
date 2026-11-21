import { z } from 'zod'

/** Validazione degli input delle API degli agenti (tutti i limiti sono anche nel database). */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'uuid')
const text = (min: number, max: number) => z.string().trim().min(min).max(max)

export const templateSchema = z.enum(['prospecting', 'follow_up_review', 'growth_report'])

export const prospectingParamsSchema = z
  .object({
    sector: text(2, 80),
    location: text(2, 120),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).default('IT'),
    keywords: text(0, 200).default(''),
    website_filter: z.enum(['any', 'with', 'without']).default('any'),
    // Google Places è escluso: la licenza non consente la memorizzazione necessaria ai passi successivi.
    provider: z.enum(['auto', 'osm_overpass']).default('auto'),
    // Nessun provider attuale fornisce la dimensione aziendale: valori diversi da "any" sono segnalati.
    company_size: z.enum(['any', 'micro', 'small', 'medium', 'large']).default('any'),
    max_results: z.number().int().min(1).max(50).default(30),
    analyze_top: z.number().int().min(0).max(50).default(10),
    proposals_top: z.number().int().min(0).max(20).default(0),
    min_score: z.number().int().min(0).max(100).default(50),
  })
  .strict()
  .refine((p) => p.analyze_top <= p.max_results, { path: ['analyze_top'], message: 'analyze_top_gt_max_results' })
  .refine((p) => p.proposals_top <= p.max_results, { path: ['proposals_top'], message: 'proposals_top_gt_max_results' })
export type ProspectingParams = z.infer<typeof prospectingParamsSchema>

export const followUpParamsSchema = z
  .object({
    stale_days: z.number().int().min(3).max(90).default(14),
    opportunity_stale_days: z.number().int().min(7).max(180).default(30),
    max_tasks: z.number().int().min(1).max(50).default(25),
    prepare_drafts: z.boolean().default(false),
    drafts_max: z.number().int().min(0).max(10).default(3),
  })
  .strict()
export type FollowUpParams = z.infer<typeof followUpParamsSchema>

export const growthParamsSchema = z.object({ period_days: z.number().int().min(7).max(365).default(90) }).strict()
export type GrowthParams = z.infer<typeof growthParamsSchema>

export const PARAM_SCHEMAS = {
  prospecting: prospectingParamsSchema,
  follow_up_review: followUpParamsSchema,
  growth_report: growthParamsSchema,
} as const

export const planInputSchema = z.object({
  organization_id: uuid,
  template: templateSchema.optional(),
  objective: text(0, 1000).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
})

export const startInputSchema = z.object({
  organization_id: uuid,
  template: templateSchema,
  objective: text(0, 1000).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  budget_credits: z.number().int().min(0).max(5000),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
})

export const controlInputSchema = z.object({
  organization_id: uuid,
  workflow_id: uuid,
  action: z.enum(['cancel', 'approve', 'reject']),
  approval_id: uuid.optional(),
  note: text(0, 500).optional(),
})

export const rescoreInputSchema = z
  .object({
    organization_id: uuid,
    candidate_ids: z.array(uuid).max(50).default([]),
    lead_ids: z.array(uuid).max(50).default([]),
  })
  .refine((v) => v.candidate_ids.length + v.lead_ids.length > 0, { message: 'empty' })
