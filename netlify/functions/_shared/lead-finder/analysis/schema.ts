import { z } from 'zod'

/** Output grezzo richiesto al modello (JSON Schema rigoroso). */
const basis = z.enum(['verified', 'hypothesis', 'missing'])
export const modelOutputSchema = z.object({
  sector: z.object({ value: z.string(), basis, evidence: z.string() }),
  activity_description: z.object({ value: z.string(), basis, evidence: z.string() }),
  verified_facts: z.array(z.object({ statement: z.string(), evidence: z.string() })).max(15),
  hypotheses: z.array(z.object({ statement: z.string(), rationale: z.string() })).max(10),
  digital_needs: z.array(z.object({ need: z.string(), rationale: z.string(), evidence: z.string() })).max(8),
  opportunities: z.array(z.object({ opportunity: z.string(), rationale: z.string() })).max(8),
  missing_information: z.array(z.string()).max(12),
  fit: z.object({ sector_rating: z.number(), sector_reason: z.string(), icp_rating: z.number(), icp_reason: z.string() }),
  signals: z.array(z.object({ signal: z.string(), evidence: z.string() })).max(10),
  qualification_reason: z.string(),
})
export type ModelOutput = z.infer<typeof modelOutputSchema>

const str = { type: 'string' } as const
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const basisSchema = { type: 'string', enum: ['verified', 'hypothesis', 'missing'] }
const arr = (items: unknown) => ({ type: 'array', items })

/** JSON Schema per OpenAI Structured Outputs (strict: tutti i campi obbligatori). */
export const modelOutputJsonSchema = obj({
  sector: obj({ value: str, basis: basisSchema, evidence: str }),
  activity_description: obj({ value: str, basis: basisSchema, evidence: str }),
  verified_facts: arr(obj({ statement: str, evidence: str })),
  hypotheses: arr(obj({ statement: str, rationale: str })),
  digital_needs: arr(obj({ need: str, rationale: str, evidence: str })),
  opportunities: arr(obj({ opportunity: str, rationale: str })),
  missing_information: arr(str),
  fit: obj({ sector_rating: { type: 'integer' }, sector_reason: str, icp_rating: { type: 'integer' }, icp_reason: str }),
  signals: arr(obj({ signal: str, evidence: str })),
  qualification_reason: str,
})

export type WebsiteStatus = 'analyzed' | 'no_website' | 'robots_disallowed' | 'fetch_failed' | 'blocked_address' | 'unsupported_content'

/** Analisi memorizzata: fatti verificati, ipotesi e informazioni mancanti sempre distinti. */
export interface AnalysisResult {
  version: 1
  model: string
  analyzed_at: string
  website: { url: string | null; status: WebsiteStatus; fetched_at: string | null }
  sector: { value: string; basis: 'verified' | 'hypothesis' | 'missing'; evidence: string }
  activity_description: { value: string; basis: 'verified' | 'hypothesis' | 'missing'; evidence: string }
  /** Fatti dal provider (generati dal codice) e dal sito (citazione verificata nel testo). */
  verified_facts: { statement: string; source: 'provider' | 'website'; evidence: string }[]
  hypotheses: { statement: string; rationale: string }[]
  /** Sempre ipotesi: non sono richieste espresse dal potenziale cliente. */
  digital_needs: { need: string; rationale: string; evidence: string; basis: 'hypothesis' }[]
  opportunities: { opportunity: string; rationale: string }[]
  missing_information: string[]
  fit: { sector_rating: number; sector_reason: string; icp_rating: number; icp_reason: string }
  signals: { signal: string; evidence: string; verified: boolean }[]
  qualification_reason: string
  usage: { input_tokens: number; output_tokens: number }
}
