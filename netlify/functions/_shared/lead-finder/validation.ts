import { z } from 'zod'
import { HttpError } from '../http'

/** Validazione degli input delle API Lead Finder (lato server, mai fidarsi del client). */
const text = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(min).max(max))

const uuid = z.string().uuid()
const iso2 = z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase())

export const searchInputSchema = z.object({
  organization_id: uuid,
  search_id: uuid,
  provider: z.enum(['osm_overpass', 'google_places']),
  sector: text(2, 80),
  location: text(2, 120),
  country: iso2,
  keywords: text(0, 200).optional().default(''),
  max_results: z.number().int().min(1).max(100),
  website_filter: z.enum(['any', 'with', 'without']).default('any'),
})
export type SearchInput = z.infer<typeof searchInputSchema>

export const candidateIdsSchema = z.object({
  organization_id: uuid,
  candidate_ids: z.array(uuid).min(1).max(50),
})

export const exclusionSchema = candidateIdsSchema.extend({
  excluded: z.boolean(),
  reason: text(0, 500).optional(),
})

const ephemeralCompany = z.object({
  companyName: text(1, 300),
  sector: text(0, 200).nullable(),
  address: text(0, 300).nullable(),
  city: text(0, 120).nullable(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable(),
  website: z.string().max(500).nullable(),
  phone: text(0, 60).nullable(),
})

export const analyzeInputSchema = z.object({
  organization_id: uuid,
  candidate_id: uuid,
  keywords: z.array(text(1, 60)).max(10).optional().default([]),
  /** Solo per provider che non consentono la memorizzazione (Google): dati della sessione corrente. */
  ephemeral: ephemeralCompany.optional(),
})

export const csvRowSchema = z.object({
  company_name: text(1, 300),
  website: z.string().max(500).optional().nullable(),
  phone: z.string().max(60).optional().nullable(),
  sector: text(0, 200).optional().nullable(),
  address: text(0, 300).optional().nullable(),
  city: text(0, 120).optional().nullable(),
  region: text(0, 120).optional().nullable(),
  postal_code: text(0, 20).optional().nullable(),
  country: z.string().max(10).optional().nullable(),
  external_id: text(0, 200).optional().nullable(),
})
export type CsvRow = z.infer<typeof csvRowSchema>

export const importInputSchema = z.object({
  organization_id: uuid,
  search_id: uuid,
  file_name: text(1, 200),
  source: z.object({
    name: text(2, 160),
    description: text(0, 2000).optional(),
    legal_basis: z.enum(['legitimate_interest', 'consent', 'contract', 'public_professional_data']),
    acquired_at: z.string().datetime({ offset: true }).optional(),
    confirmed_lawful: z.literal(true),
  }),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
})

export function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  if (!r.success) {
    const fields = r.error.issues.slice(0, 5).map((i) => i.path.join('.') || '(root)')
    throw new HttpError(400, 'invalid_input', { fields })
  }
  return r.data
}
