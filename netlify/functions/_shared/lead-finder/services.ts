import { HttpError } from '../http'
import { log } from '../log'
import { deduplicate, crmKey } from './dedup'
import { cleanText, dedupKey as makeDedupKey, normalizeCountry, normalizePhone, normalizeWebsite } from './normalize'
import { CSV_LICENSE, type SearchProviderId } from './providers/registry'
import { scoreLead, type ScorableCompany, type ScoreResult } from './scoring'
import { csvRowSchema, type SearchInput } from './validation'
import { ProviderError, type NormalizedCompany, type ProviderAdapter, type ProviderId } from './types'
import type { CandidateRecord, CandidateWrite, LeadFinderStore } from './store'
import { createHash } from 'node:crypto'
import type { AnalysisResult } from './analysis/schema'
import type { BillingGate } from '../billing/store'

export interface Ctx {
  orgId: string
  userId: string
}

export const PROVIDER_TIMEOUT_MS = 9000

const providerHttpStatus: Record<string, number> = {
  provider_not_configured: 409,
  provider_timeout: 504,
  provider_rate_limited: 429,
  provider_auth_failed: 502,
  provider_bad_request: 400,
  provider_bad_response: 502,
  provider_unavailable: 503,
  location_not_found: 404,
}

/** Rate limit per utente + controllo quota: eccezioni con codici leggibili dall'interfaccia. */
async function guard(store: LeadFinderStore, ctx: Ctx, bucket: string) {
  const rl = await store.checkRateLimit(ctx.orgId, ctx.userId, bucket)
  if (!rl.allowed) throw new HttpError(429, 'rate_limited', { retry_after: rl.retry_after ?? 60 })
}

function toScorable(c: NormalizedCompany | CandidateRecord): ScorableCompany {
  return {
    companyName: c.companyName,
    sector: c.sector,
    categoryTags: c.categoryTags,
    address: c.address,
    city: c.city,
    region: c.region,
    country: c.country,
    website: c.website,
    phone: c.phone,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Lead Search Service
// ════════════════════════════════════════════════════════════════════════════
export interface SearchResponse {
  search_id: string
  provider: ProviderId
  counts: { found: number; new: number; already_known: number; duplicates_in_batch: number; excluded: number; in_crm: number }
  usage: { searches: { used: number; limit: number }; results: { used: number; limit: number } }
  license: ProviderAdapter['license']
  /** Quota commerciale del piano (nuovi lead per periodo di fatturazione), se applicata. */
  plan_leads?: { counted: number; already_counted: number; over_quota: number; remaining: number | null; limit: number | null; partial: boolean }
  /** Solo per provider che non consentono la memorizzazione: dati mostrati in sessione. */
  ephemeral?: { candidate_id: string; company: NormalizedCompany; score: ScoreResult; in_crm: boolean; excluded: boolean }[]
}

export async function runSearch(
  deps: { store: LeadFinderStore; registry: Record<SearchProviderId, ProviderAdapter>; billing?: BillingGate },
  ctx: Ctx,
  input: SearchInput,
): Promise<SearchResponse> {
  const { store } = deps
  const adapter = deps.registry[input.provider]
  const missing = adapter.missingConfig()
  if (missing.length) throw new HttpError(409, 'provider_not_configured', { missing })
  if (input.website_filter === 'with' && !adapter.capabilities.websiteFilterWith) throw new HttpError(400, 'filter_not_supported')
  if (input.website_filter === 'without' && !adapter.capabilities.websiteFilterWithout) throw new HttpError(400, 'filter_not_supported')

  await guard(store, ctx, 'lead_finder')

  // Quota commerciale del piano: verificata PRIMA di interrogare il provider (nessun costo inutile).
  const planQuota = deps.billing ? await deps.billing.leadQuota(ctx.orgId) : null
  if (planQuota?.enforced && !planQuota.allowed) {
    throw new HttpError(402, `billing_${planQuota.reason ?? 'lead_quota_exceeded'}`, { used: planQuota.used ?? 0, limit: planQuota.limit ?? 0 })
  }

  // Quota risultati: si verifica prima, si consuma sul numero effettivo trovato.
  const resultsQuota = await store.consumeUsage(ctx.orgId, ctx.userId, 'lead_result', 0)
  if (resultsQuota.remaining <= 0) throw new HttpError(429, 'quota_results_exceeded', { used: resultsQuota.used, limit: resultsQuota.limit })
  const searchQuota = await store.consumeUsage(ctx.orgId, ctx.userId, 'lead_search', 1, { provider: input.provider })
  if (!searchQuota.allowed) throw new HttpError(429, 'quota_searches_exceeded', { used: searchQuota.used, limit: searchQuota.limit })

  const planRemaining = planQuota?.enforced ? Math.max(planQuota.remaining ?? 0, 0) : Number.POSITIVE_INFINITY
  const maxResults = Math.min(input.max_results, adapter.capabilities.maxResults, resultsQuota.remaining, planRemaining)
  // Ricerca parziale: il piano consente meno risultati di quelli richiesti.
  const partialByPlan = planRemaining < Math.min(input.max_results, adapter.capabilities.maxResults)
  const keywords = input.keywords.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 10)
  const query = { sector: input.sector, location: input.location, country: input.country, keywords, maxResults, websiteFilter: input.website_filter }

  await store.createSearch({
    id: input.search_id,
    org: ctx.orgId,
    provider: input.provider,
    params: { sector: input.sector, location: input.location, country: input.country, keywords, max_results: maxResults, website_filter: input.website_filter },
    createdBy: ctx.userId,
  })

  try {
    const started = Date.now()
    // Costo del provider registrato per chiamata (stima configurabile in billing_settings).
    await deps.billing?.recordProviderCall(ctx.orgId, ctx.userId, input.provider, `provider:${input.search_id}`)
    const found = await adapter.search(query, { timeoutMs: PROVIDER_TIMEOUT_MS })
    log('info', 'lead_search.provider_ok', { provider: input.provider, count: found.length, ms: Date.now() - started })

    await store.updateSearch(ctx.orgId, input.search_id, { stage: 'deduplicating' })
    const ids = found.map((c) => c.externalId)
    const keys = found.map((c) => makeDedupKey(c)).filter((k): k is string => !!k)
    const [existing, crmKeys] = await Promise.all([
      store.findCandidatesByExternalIds(ctx.orgId, input.provider, ids),
      store.findCrmKeys(ctx.orgId, input.provider, ids, keys),
    ])
    const dedup = deduplicate({ batch: found, existingCandidates: existing, crmKeys })

    await store.updateSearch(ctx.orgId, input.search_id, { stage: 'scoring' })
    const profile = await store.getProfile(ctx.orgId)
    const store_ = adapter.license.canStoreContent
    const scored = dedup.items.map((item) => ({ ...item, score: scoreLead(toScorable(item.company), profile, null) }))

    await store.updateSearch(ctx.orgId, input.search_id, { stage: 'saving' })
    const writes: CandidateWrite[] = scored.map((it) => ({
      provider: input.provider,
      externalId: it.company.externalId,
      searchId: input.search_id,
      canStoreContent: adapter.license.canStoreContent,
      canExport: adapter.license.canExport,
      canSaveToCrm: adapter.license.canSaveToCrm,
      attribution: adapter.license.attribution,
      sourceUrl: store_ ? it.company.sourceUrl : null,
      dedupKey: store_ ? it.dedupKey : null,
      acquiredAt: it.company.acquiredAt,
      content: store_ ? pickContent(it.company) : null,
      score: store_ ? it.score : null,
      // Un punteggio già calcolato con l'analisi AI non viene sostituito da quello a regole.
      keepExistingScore: it.existing?.scoreBasis === 'ai',
      isNew: !it.existing,
    }))
    const idMap = await store.writeCandidates(ctx.orgId, writes)

    const newCount = dedup.items.filter((i) => !i.existing).length
    // Nuovi lead del piano: contati per candidate id (un lead rivisto non viene ricontato).
    const overQuota = new Set<string>()
    let planLeads: SearchResponse['plan_leads']
    if (deps.billing) {
      const newIds = dedup.items.filter((i) => !i.existing).map((i) => idMap.get(i.company.externalId)).filter((v): v is string => !!v)
      const counted = await deps.billing.countNewLeads(ctx.orgId, ctx.userId, newIds, { search_id: input.search_id, provider: input.provider })
      if (counted.enforced) {
        // Oltre quota (ricerche concorrenti): i candidati restano esclusi e non utilizzabili.
        const now = new Date().toISOString()
        for (const ref of counted.over_quota_refs) {
          overQuota.add(ref)
          await store.updateCandidate(ctx.orgId, ref, { status: 'excluded', excludedReason: 'lead_quota_exceeded', excludedAt: now, excludedBy: null })
        }
        planLeads = {
          counted: counted.counted,
          already_counted: counted.already_counted,
          over_quota: counted.over_quota_refs.length,
          remaining: counted.remaining ?? null,
          limit: counted.limit ?? null,
          partial: partialByPlan || counted.over_quota_refs.length > 0,
        }
        if (counted.over_quota_refs.length) log('warn', 'lead_search.plan_quota_race', { search_id: input.search_id, over: counted.over_quota_refs.length })
      }
    }
    const consumed = await store.consumeUsage(ctx.orgId, ctx.userId, 'lead_result', newCount, { search_id: input.search_id })
    if (!consumed.allowed) log('warn', 'lead_search.result_quota_race', { search_id: input.search_id })

    await store.updateSearch(ctx.orgId, input.search_id, {
      stage: 'done',
      status: 'completed',
      results_count: dedup.items.length,
      new_count: newCount,
      duplicate_count: dedup.alreadyKnown + dedup.duplicatesInBatch,
      excluded_count: dedup.excluded,
      completed_at: new Date().toISOString(),
    })

    return {
      search_id: input.search_id,
      provider: input.provider,
      counts: {
        found: dedup.items.length,
        new: newCount,
        already_known: dedup.alreadyKnown,
        duplicates_in_batch: dedup.duplicatesInBatch,
        excluded: dedup.excluded,
        in_crm: dedup.inCrm,
      },
      usage: {
        searches: { used: searchQuota.used, limit: searchQuota.limit },
        results: { used: consumed.allowed ? consumed.used : resultsQuota.used, limit: resultsQuota.limit },
      },
      license: adapter.license,
      ...(planLeads ? { plan_leads: planLeads } : {}),
      ...(store_
        ? {}
        : {
            ephemeral: scored.map((it) => ({
              candidate_id: idMap.get(it.company.externalId) ?? '',
              company: it.company,
              score: it.score,
              in_crm: it.inCrm,
              excluded: it.existing?.status === 'excluded' || overQuota.has(idMap.get(it.company.externalId) ?? ''),
            })),
          }),
    }
  } catch (err) {
    const code = err instanceof ProviderError ? err.code : 'internal_error'
    await store
      .updateSearch(ctx.orgId, input.search_id, { stage: 'failed', status: 'failed', error_code: code, completed_at: new Date().toISOString() })
      .catch(() => undefined)
    if (err instanceof ProviderError) {
      log('warn', 'lead_search.provider_error', { provider: input.provider, code })
      throw new HttpError(providerHttpStatus[err.code] ?? 502, err.code, { retryable: err.retryable })
    }
    throw err
  }
}

function pickContent(c: NormalizedCompany): NonNullable<CandidateWrite['content']> {
  return {
    companyName: c.companyName,
    sector: c.sector,
    categoryTags: c.categoryTags,
    address: c.address,
    city: c.city,
    region: c.region,
    postalCode: c.postalCode,
    country: c.country,
    website: c.website,
    phone: c.phone,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Importazione CSV di dati legittimamente acquisiti
// ════════════════════════════════════════════════════════════════════════════
export interface ImportInput {
  search_id: string
  file_name: string
  source: { name: string; description?: string; legal_basis: string; acquired_at?: string }
  rows: Record<string, unknown>[]
}

export async function importCsv(deps: { store: LeadFinderStore; billing?: BillingGate }, ctx: Ctx, input: ImportInput) {
  const { store } = deps
  await guard(store, ctx, 'lead_finder')
  const quota = await store.consumeUsage(ctx.orgId, ctx.userId, 'lead_result', 0)

  const invalid: { row: number; error: string }[] = []
  const companies: NormalizedCompany[] = []
  const acquiredAt = input.source.acquired_at ?? new Date().toISOString()
  input.rows.forEach((raw, i) => {
    const parsed = csvRowSchema.safeParse(raw)
    if (!parsed.success) return invalid.push({ row: i + 1, error: parsed.error.issues[0]?.path.join('.') ?? 'invalid' })
    const r = parsed.data
    const websiteRaw = r.website?.trim() || null
    const website = normalizeWebsite(websiteRaw)
    if (websiteRaw && !website) return invalid.push({ row: i + 1, error: 'website' })
    const country = r.country ? normalizeCountry(r.country) : null
    if (r.country && !country) return invalid.push({ row: i + 1, error: 'country' })
    const base = {
      provider: 'csv_import' as const,
      companyName: r.company_name,
      sector: cleanText(r.sector, 200),
      categoryTags: [],
      address: cleanText(r.address, 300),
      city: cleanText(r.city, 120),
      region: cleanText(r.region, 120),
      postalCode: cleanText(r.postal_code, 20),
      country,
      website,
      phone: normalizePhone(r.phone),
      sourceUrl: null,
      acquiredAt,
    }
    const key = makeDedupKey(base) ?? `${base.companyName}|${i}`
    const externalId = cleanText(r.external_id, 200) ?? `sha256:${createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 32)}`
    companies.push({ ...base, externalId })
  })

  if (companies.length === 0) throw new HttpError(400, 'import_no_valid_rows', { invalid: invalid.slice(0, 50) })

  const ids = companies.map((c) => c.externalId)
  const keys = companies.map((c) => makeDedupKey(c)).filter((k): k is string => !!k)
  const [existing, crmKeys] = await Promise.all([
    store.findCandidatesByExternalIds(ctx.orgId, 'csv_import', ids),
    store.findCrmKeys(ctx.orgId, 'csv_import', ids, keys),
  ])
  const dedup = deduplicate({ batch: companies, existingCandidates: existing, crmKeys })
  const newItems = dedup.items.filter((i) => !i.existing)
  if (newItems.length > quota.remaining) {
    throw new HttpError(429, 'quota_results_exceeded', { used: quota.used, limit: quota.limit, needed: newItems.length })
  }
  // Quota del piano: l'importazione è tutto-o-niente rispetto ai nuovi lead disponibili.
  const planQuota = deps.billing ? await deps.billing.leadQuota(ctx.orgId) : null
  if (planQuota?.enforced && (!planQuota.allowed ? newItems.length > 0 : newItems.length > (planQuota.remaining ?? 0))) {
    throw new HttpError(402, 'billing_lead_quota_exceeded', { used: planQuota.used ?? 0, limit: planQuota.limit ?? 0, needed: newItems.length })
  }

  const sourceId = await store.createImportSource(ctx.orgId, {
    name: input.source.name,
    description: input.source.description ?? `Importazione CSV: ${input.file_name}`,
    legalBasis: input.source.legal_basis,
    acquiredAt,
    createdBy: ctx.userId,
  })
  await store.createSearch({
    id: input.search_id,
    org: ctx.orgId,
    provider: 'csv_import',
    params: { file_name: input.file_name, rows: input.rows.length, source_id: sourceId },
    createdBy: ctx.userId,
  })
  const profile = await store.getProfile(ctx.orgId)
  const importedIds = await store.writeCandidates(
    ctx.orgId,
    dedup.items.map((it) => ({
      provider: 'csv_import',
      externalId: it.company.externalId,
      searchId: input.search_id,
      sourceId,
      ...{ canStoreContent: CSV_LICENSE.canStoreContent, canExport: CSV_LICENSE.canExport, canSaveToCrm: CSV_LICENSE.canSaveToCrm },
      attribution: null,
      sourceUrl: null,
      dedupKey: it.dedupKey,
      acquiredAt,
      content: pickContent(it.company),
      score: scoreLead(toScorable(it.company), profile, null),
      keepExistingScore: it.existing?.scoreBasis === 'ai',
      isNew: !it.existing,
    })),
  )
  if (deps.billing) {
    const refs = newItems.map((i) => importedIds.get(i.company.externalId)).filter((v): v is string => !!v)
    const counted = await deps.billing.countNewLeads(ctx.orgId, ctx.userId, refs, { search_id: input.search_id, kind: 'csv' })
    const now = new Date().toISOString()
    for (const ref of counted.over_quota_refs) {
      await store.updateCandidate(ctx.orgId, ref, { status: 'excluded', excludedReason: 'lead_quota_exceeded', excludedAt: now, excludedBy: null })
    }
  }
  await store.consumeUsage(ctx.orgId, ctx.userId, 'lead_result', newItems.length, { search_id: input.search_id, kind: 'csv' })
  await store.updateSearch(ctx.orgId, input.search_id, {
    stage: 'done',
    status: 'completed',
    results_count: dedup.items.length,
    new_count: newItems.length,
    duplicate_count: dedup.alreadyKnown + dedup.duplicatesInBatch,
    excluded_count: dedup.excluded,
    completed_at: new Date().toISOString(),
  })
  await store.audit(ctx.orgId, ctx.userId, 'lead_finder.csv_imported', 'lead_source', sourceId, { rows: input.rows.length, valid: companies.length })
  return {
    search_id: input.search_id,
    source_id: sourceId,
    counts: { rows: input.rows.length, valid: companies.length, invalid: invalid.length, new: newItems.length, already_known: dedup.alreadyKnown, duplicates_in_batch: dedup.duplicatesInBatch, in_crm: dedup.inCrm },
    invalid: invalid.slice(0, 50),
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CRM Persistence
// ════════════════════════════════════════════════════════════════════════════
export type SaveOutcome = 'saved' | 'already_saved' | 'duplicate' | 'not_allowed' | 'excluded' | 'not_found' | 'suppressed'

export function scoreExplanation(analysis: AnalysisResult | null, breakdown: { key: string; points: number; max: number }[] | null): string | null {
  if (!breakdown) return null
  const parts = breakdown.map((b) => `${b.key} ${b.points}/${b.max}`).join(' · ')
  return [parts, analysis?.qualification_reason].filter(Boolean).join('\n').slice(0, 4000)
}

export async function saveToCrm(deps: { store: LeadFinderStore; providerLabels: Record<ProviderId, string> }, ctx: Ctx, candidateIds: string[]) {
  const { store } = deps
  await guard(store, ctx, 'lead_finder')
  const candidates = await store.getCandidates(ctx.orgId, candidateIds)
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const results: { candidate_id: string; outcome: SaveOutcome; lead_id?: string }[] = []

  for (const id of candidateIds) {
    const c = byId.get(id)
    if (!c) {
      results.push({ candidate_id: id, outcome: 'not_found' })
      continue
    }
    if (!c.canSaveToCrm || !c.canStoreContent || !c.companyName) {
      results.push({ candidate_id: id, outcome: 'not_allowed' })
      continue
    }
    if (c.status === 'excluded') {
      results.push({ candidate_id: id, outcome: 'excluded' })
      continue
    }
    if (c.status === 'saved' && c.leadId) {
      results.push({ candidate_id: id, outcome: 'already_saved', lead_id: c.leadId })
      continue
    }
    const sourceId =
      c.sourceId ??
      (await store.ensureProviderSource(ctx.orgId, c.provider, {
        name: deps.providerLabels[c.provider],
        licenseNote: c.attribution ?? '',
        sourceUrl: c.provider === 'osm_overpass' ? 'https://www.openstreetmap.org/copyright' : null,
        createdBy: ctx.userId,
      }))
    const res = await store.insertLead(ctx.orgId, {
      sourceId,
      provider: c.provider,
      externalId: c.externalId,
      dedupKey: c.dedupKey,
      companyName: c.companyName,
      website: c.website,
      phone: c.phone,
      industry: c.analysis?.sector.value || c.sector,
      city: c.city,
      region: c.region,
      country: c.country,
      notes: c.sourceUrl ? `Fonte: ${c.sourceUrl}${c.attribution ? ` (${c.attribution})` : ''}` : null,
      score: c.score,
      priority: c.priority,
      scoreBasis: c.scoreBasis,
      scoreBreakdown: c.scoreBreakdown,
      scoreExplanation: scoreExplanation(c.analysis, c.scoreBreakdown),
      acquiredAt: c.acquiredAt,
      lastAnalyzedAt: c.lastAnalyzedAt,
      createdBy: ctx.userId,
    })
    if (!res.ok) {
      results.push({ candidate_id: id, outcome: res.reason })
      continue
    }
    await store.updateCandidate(ctx.orgId, id, { status: 'saved', leadId: res.id })
    if (c.analysis) await store.insertLeadAnalysis(ctx.orgId, res.id, c.analysis, null)
    await store.audit(ctx.orgId, ctx.userId, 'lead_finder.saved_to_crm', 'lead', res.id, { provider: c.provider, candidate_id: id })
    results.push({ candidate_id: id, outcome: 'saved', lead_id: res.id })
  }
  return { results, saved: results.filter((r) => r.outcome === 'saved').length }
}

// ════════════════════════════════════════════════════════════════════════════
// Esclusione
// ════════════════════════════════════════════════════════════════════════════
export async function setExclusion(deps: { store: LeadFinderStore; billing?: BillingGate }, ctx: Ctx, ids: string[], excluded: boolean, reason?: string) {
  const { store } = deps
  await guard(store, ctx, 'lead_finder')
  const candidates = await store.getCandidates(ctx.orgId, ids)
  // Ripristino: i candidati non ancora conteggiati (es. esclusi per quota) consumano quota del piano.
  let blocked = new Set<string>()
  if (!excluded && deps.billing) {
    const toRestore = candidates.filter((c) => c.status === 'excluded').map((c) => c.id)
    const counted = await deps.billing.countNewLeads(ctx.orgId, ctx.userId, toRestore, { kind: 'restore' })
    blocked = new Set(counted.over_quota_refs)
  }
  let changed = 0
  for (const c of candidates) {
    if (c.status === 'saved') continue // già nel CRM: si gestisce dal CRM (opposizione/soppressione)
    if (blocked.has(c.id)) continue
    if (excluded && c.status !== 'excluded') {
      await store.updateCandidate(ctx.orgId, c.id, { status: 'excluded', excludedReason: reason ?? null, excludedAt: new Date().toISOString(), excludedBy: ctx.userId })
      changed++
    } else if (!excluded && c.status === 'excluded') {
      await store.updateCandidate(ctx.orgId, c.id, { status: 'new', excludedReason: null, excludedAt: null, excludedBy: null })
      changed++
    }
  }
  if (changed) await store.audit(ctx.orgId, ctx.userId, excluded ? 'lead_finder.excluded' : 'lead_finder.restored', 'lead_candidate', null, { count: changed })
  return blocked.size ? { changed, blocked_by_plan_quota: blocked.size } : { changed }
}

// ════════════════════════════════════════════════════════════════════════════
// Esportazione CSV (solo dove la licenza lo consente)
// ════════════════════════════════════════════════════════════════════════════
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)
  // Protezione da CSV/formula injection nei fogli di calcolo.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function exportCandidatesCsv(deps: { store: LeadFinderStore }, ctx: Ctx, searchId: string | null) {
  const { store } = deps
  await guard(store, ctx, 'lead_finder_export')
  const rows = await store.listExportableCandidates(ctx.orgId, searchId, 5000)
  const header = ['company_name', 'sector', 'address', 'city', 'region', 'postal_code', 'country', 'website', 'phone', 'score', 'priority', 'status', 'provider', 'external_id', 'source_url', 'acquired_at', 'attribution']
  const lines = [header.join(',')]
  for (const r of rows) {
    if (!r.canExport) continue
    lines.push(
      [r.companyName, r.sector, r.address, r.city, r.region, r.postalCode, r.country, r.website, r.phone, r.score, r.priority, r.status, r.provider, r.externalId, r.sourceUrl, r.acquiredAt, r.attribution].map(csvCell).join(','),
    )
  }
  await store.audit(ctx.orgId, ctx.userId, 'lead_finder.exported', 'lead_search', searchId, { rows: lines.length - 1 })
  return { csv: lines.join('\r\n') + '\r\n', rows: lines.length - 1 }
}

export { crmKey }
