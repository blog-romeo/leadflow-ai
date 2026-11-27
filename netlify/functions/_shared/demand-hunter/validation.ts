import { z } from 'zod'
import { HttpError } from '../http'

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
const goal = z.enum(['clienti', 'lavoro'])
// Testo libero breve: niente caratteri di controllo (finisce nelle query Google tra virgolette).
const subject = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => !/[\u0000-\u001f"\u007f]/.test(s), 'invalid_text')

export const MAX_BUDGET = 500

const huntInput = z.object({ organization_id: uuid, action: z.literal('hunt'), goal, seed: subject, budget: z.number().int().min(1).max(MAX_BUDGET) })
const expandInput = z.object({ organization_id: uuid, action: z.literal('expand'), goal, label: subject })
export const estimateSchema = z.discriminatedUnion('action', [huntInput, expandInput])
export const startSchema = z.discriminatedUnion('action', [
  huntInput.extend({ confirm_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  expandInput.extend({ confirm_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
])
export const jobRefSchema = z.object({ organization_id: uuid, job_id: uuid })
export const feedbackSchema = z.object({ organization_id: uuid, lead_id: uuid, verdict: z.enum(['giusto', 'sbagliato']).nullable() })
export const crmSchema = z.object({ organization_id: uuid, lead_ids: z.array(uuid).min(1).max(100) })
export const orgGoalSchema = z.object({ organization_id: uuid, goal })
export const orgSchema = z.object({ organization_id: uuid })

export type EstimateInput = z.infer<typeof estimateSchema>
export type StartInput = z.infer<typeof startSchema>

export function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  if (!r.success) throw new HttpError(400, 'invalid_input', { fields: r.error.issues.map((i) => i.path.join('.')).slice(0, 10) })
  return r.data
}

export function queryParams(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries())
}
