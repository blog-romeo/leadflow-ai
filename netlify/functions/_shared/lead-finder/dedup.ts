import type { NormalizedCompany } from './types'
import { dedupKey } from './normalize'

export interface ExistingCandidate {
  id: string
  externalId: string
  status: 'new' | 'saved' | 'excluded'
  leadId: string | null
  scoreBasis: 'rules' | 'ai' | null
}

export interface DedupInput {
  batch: NormalizedCompany[]
  existingCandidates: ExistingCandidate[]
  /** Chiavi già presenti nel CRM: dedup_key e provider:externalId. */
  crmKeys: Set<string>
}

export interface DedupResult {
  /** Risultati unici del batch, ciascuno con la propria chiave e lo stato pregresso. */
  items: Array<{
    company: NormalizedCompany
    dedupKey: string | null
    existing: ExistingCandidate | null
    inCrm: boolean
  }>
  duplicatesInBatch: number
  alreadyKnown: number
  excluded: number
  inCrm: number
}

export const crmKey = {
  external: (provider: string, externalId: string) => `ext:${provider}:${externalId}`,
  dedup: (key: string) => `dk:${key}`,
}

/** Deduplica un batch rispetto a se stesso, ai candidati già visti e al CRM. */
export function deduplicate({ batch, existingCandidates, crmKeys }: DedupInput): DedupResult {
  const byExternal = new Map(existingCandidates.map((c) => [c.externalId, c]))
  const seenExternal = new Set<string>()
  const seenKeys = new Set<string>()
  const result: DedupResult = { items: [], duplicatesInBatch: 0, alreadyKnown: 0, excluded: 0, inCrm: 0 }

  for (const company of batch) {
    const key = dedupKey(company)
    if (seenExternal.has(company.externalId) || (key && seenKeys.has(key))) {
      result.duplicatesInBatch++
      continue
    }
    seenExternal.add(company.externalId)
    if (key) seenKeys.add(key)

    const existing = byExternal.get(company.externalId) ?? null
    const inCrm =
      existing?.status === 'saved' ||
      crmKeys.has(crmKey.external(company.provider, company.externalId)) ||
      (key !== null && crmKeys.has(crmKey.dedup(key)))
    if (existing) result.alreadyKnown++
    if (existing?.status === 'excluded') result.excluded++
    if (inCrm) result.inCrm++
    result.items.push({ company, dedupKey: key, existing, inCrm })
  }
  return result
}
