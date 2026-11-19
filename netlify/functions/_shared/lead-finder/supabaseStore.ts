import type { SupabaseClient } from '@supabase/supabase-js'
import { HttpError } from '../http'
import { log } from '../log'
import { crmKey, type ExistingCandidate } from './dedup'
import { profileFromRow, type ProfileRowDb } from './profile'
import type { AiJobRecord, CandidateRecord, CandidateWrite, LeadFinderStore, QuotaResult } from './store'
import type { ProviderId } from './types'

/**
 * Implementazione Supabase dello store (service role).
 * Ogni query filtra esplicitamente per organization_id: il service role bypassa RLS,
 * quindi l'isolamento tra tenant è garantito qui e dai vincoli del database.
 */
type Row = Record<string, unknown>

function fail(op: string, error: { message?: string; code?: string } | null): never {
  log('error', 'store_error', { op, code: error?.code })
  throw new HttpError(500, 'storage_error')
}

const CANDIDATE_COLUMNS =
  'id, organization_id, provider, external_id, search_id, source_id, status, lead_id, can_store_content, can_export, can_save_to_crm, company_name, sector, category_tags, address, city, region, postal_code, country, website, phone, source_url, attribution, dedup_key, score, priority, score_basis, score_breakdown, analysis, last_analyzed_at, acquired_at'

export function mapCandidate(r: Row): CandidateRecord {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    provider: r.provider as ProviderId,
    externalId: r.external_id as string,
    searchId: (r.search_id as string) ?? null,
    sourceId: (r.source_id as string) ?? null,
    status: r.status as CandidateRecord['status'],
    leadId: (r.lead_id as string) ?? null,
    canStoreContent: !!r.can_store_content,
    canExport: !!r.can_export,
    canSaveToCrm: !!r.can_save_to_crm,
    companyName: (r.company_name as string) ?? null,
    sector: (r.sector as string) ?? null,
    categoryTags: (r.category_tags as string[]) ?? [],
    address: (r.address as string) ?? null,
    city: (r.city as string) ?? null,
    region: (r.region as string) ?? null,
    postalCode: (r.postal_code as string) ?? null,
    country: (r.country as string) ?? null,
    website: (r.website as string) ?? null,
    phone: (r.phone as string) ?? null,
    sourceUrl: (r.source_url as string) ?? null,
    attribution: (r.attribution as string) ?? null,
    dedupKey: (r.dedup_key as string) ?? null,
    score: (r.score as number) ?? null,
    priority: (r.priority as CandidateRecord['priority']) ?? null,
    scoreBasis: (r.score_basis as CandidateRecord['scoreBasis']) ?? null,
    scoreBreakdown: (r.score_breakdown as CandidateRecord['scoreBreakdown']) ?? null,
    analysis: (r.analysis as CandidateRecord['analysis']) ?? null,
    lastAnalyzedAt: (r.last_analyzed_at as string) ?? null,
    acquiredAt: r.acquired_at as string,
  }
}

function candidateRow(org: string, w: CandidateWrite): Row {
  const row: Row = {
    organization_id: org,
    provider: w.provider,
    external_id: w.externalId,
    search_id: w.searchId,
    can_store_content: w.canStoreContent,
    can_export: w.canExport,
    can_save_to_crm: w.canSaveToCrm,
    attribution: w.attribution,
    source_url: w.sourceUrl,
    dedup_key: w.dedupKey,
    last_seen_at: new Date().toISOString(),
  }
  if (w.sourceId) row.source_id = w.sourceId
  if (w.isNew) row.acquired_at = w.acquiredAt
  const c = w.content
  Object.assign(row, {
    company_name: c?.companyName ?? null,
    sector: c?.sector ?? null,
    category_tags: c?.categoryTags ?? [],
    address: c?.address ?? null,
    city: c?.city ?? null,
    region: c?.region ?? null,
    postal_code: c?.postalCode ?? null,
    country: c?.country ?? null,
    website: c?.website ?? null,
    phone: c?.phone ?? null,
  })
  if (!w.keepExistingScore) {
    Object.assign(row, {
      score: w.score?.score ?? null,
      priority: w.score?.priority ?? null,
      score_basis: w.score?.basis ?? null,
      score_breakdown: w.score?.breakdown ?? null,
    })
  }
  return row
}

export function createSupabaseStore(db: SupabaseClient): LeadFinderStore {
  return {
    async checkRateLimit(org, user, bucket) {
      const { data, error } = await db.rpc('check_rate_limit', { p_org: org, p_user: user, p_bucket: bucket })
      if (error) fail('check_rate_limit', error)
      return data as { allowed: boolean; retry_after?: number }
    },
    async consumeUsage(org, user, event, qty, metadata = {}) {
      const { data, error } = await db.rpc('consume_usage', { p_org: org, p_user: user, p_event: event, p_quantity: qty, p_metadata: metadata })
      if (error) fail('consume_usage', error)
      return data as QuotaResult
    },
    async countInflightAnalyses(org) {
      const { count, error } = await db.from('ai_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', org).in('status', ['queued', 'running'])
      if (error) fail('count_inflight', error)
      return count ?? 0
    },
    async getProfile(org) {
      const { data, error } = await db.from('organization_profiles').select('*').eq('organization_id', org).maybeSingle()
      if (error) fail('get_profile', error)
      return profileFromRow(data as ProfileRowDb | null)
    },
    async createSearch(row) {
      const { error } = await db.from('lead_searches').insert({ id: row.id, organization_id: row.org, provider: row.provider, params: row.params, created_by: row.createdBy })
      if (error?.code === '23505') throw new HttpError(409, 'search_id_conflict')
      if (error) fail('create_search', error)
    },
    async updateSearch(org, id, patch) {
      const { error } = await db.from('lead_searches').update(patch).eq('organization_id', org).eq('id', id)
      if (error) fail('update_search', error)
    },
    async findCandidatesByExternalIds(org, provider, ids) {
      if (!ids.length) return []
      const out: ExistingCandidate[] = []
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db
          .from('lead_candidates')
          .select('id, external_id, status, lead_id, score_basis')
          .eq('organization_id', org)
          .eq('provider', provider)
          .in('external_id', ids.slice(i, i + 200))
        if (error) fail('find_candidates', error)
        for (const r of data ?? []) out.push({ id: r.id, externalId: r.external_id, status: r.status, leadId: r.lead_id, scoreBasis: r.score_basis })
      }
      return out
    },
    async findCrmKeys(org, provider, externalIds, dedupKeys) {
      const keys = new Set<string>()
      if (externalIds.length) {
        const { data, error } = await db.from('leads').select('external_id').eq('organization_id', org).eq('provider', provider).in('external_id', externalIds.slice(0, 500))
        if (error) fail('crm_keys_ext', error)
        for (const r of data ?? []) keys.add(crmKey.external(provider, r.external_id as string))
      }
      if (dedupKeys.length) {
        const { data, error } = await db.from('leads').select('dedup_key').eq('organization_id', org).is('deleted_at', null).in('dedup_key', dedupKeys.slice(0, 500))
        if (error) fail('crm_keys_dedup', error)
        for (const r of data ?? []) keys.add(crmKey.dedup(r.dedup_key as string))
      }
      return keys
    },
    async writeCandidates(org, rows) {
      const idMap = new Map<string, string>()
      // Gruppi con le stesse colonne: l'upsert non deve azzerare stato, data di acquisizione,
      // fonte, lead collegato o punteggi AI già presenti.
      const groups = new Map<string, CandidateWrite[]>()
      for (const r of rows) {
        const k = `${r.isNew}|${r.keepExistingScore}|${!!r.sourceId}`
        groups.set(k, [...(groups.get(k) ?? []), r])
      }
      for (const group of groups.values()) {
        for (let i = 0; i < group.length; i += 200) {
          const chunk = group.slice(i, i + 200).map((w) => candidateRow(org, w))
          if (!chunk.length) continue
          const { data, error } = await db
            .from('lead_candidates')
            .upsert(chunk, { onConflict: 'organization_id,provider,external_id' })
            .select('id, external_id')
          if (error) fail('write_candidates', error)
          for (const r of data ?? []) idMap.set(r.external_id as string, r.id as string)
        }
      }
      return idMap
    },
    async getCandidates(org, ids) {
      if (!ids.length) return []
      const { data, error } = await db.from('lead_candidates').select(CANDIDATE_COLUMNS).eq('organization_id', org).in('id', ids)
      if (error) fail('get_candidates', error)
      return (data ?? []).map((r) => mapCandidate(r as Row))
    },
    async listExportableCandidates(org, searchId, limit) {
      let q = db.from('lead_candidates').select(CANDIDATE_COLUMNS).eq('organization_id', org).eq('can_export', true).neq('status', 'excluded').order('score', { ascending: false, nullsFirst: false }).limit(limit)
      if (searchId) q = q.eq('search_id', searchId)
      const { data, error } = await q
      if (error) fail('list_export', error)
      return (data ?? []).map((r) => mapCandidate(r as Row))
    },
    async updateCandidate(org, id, patch) {
      const row: Row = {}
      if (patch.status) row.status = patch.status
      if ('leadId' in patch) row.lead_id = patch.leadId
      if ('excludedReason' in patch) row.excluded_reason = patch.excludedReason
      if ('excludedAt' in patch) row.excluded_at = patch.excludedAt
      if ('excludedBy' in patch) row.excluded_by = patch.excludedBy
      if (patch.analysis) row.analysis = patch.analysis
      if (patch.lastAnalyzedAt) row.last_analyzed_at = patch.lastAnalyzedAt
      if (patch.score) Object.assign(row, { score: patch.score.score, priority: patch.score.priority, score_basis: patch.score.basis, score_breakdown: patch.score.breakdown })
      const { error } = await db.from('lead_candidates').update(row).eq('organization_id', org).eq('id', id)
      if (error) fail('update_candidate', error)
    },
    async ensureProviderSource(org, provider, meta) {
      const { data: found, error: e1 } = await db.from('lead_sources').select('id').eq('organization_id', org).eq('provider', provider).eq('type', 'api').maybeSingle()
      if (e1) fail('find_source', e1)
      if (found) return found.id as string
      const { data, error } = await db
        .from('lead_sources')
        .insert({
          organization_id: org,
          type: 'api',
          provider,
          name: meta.name,
          description: 'Risultati del Lead Finder salvati nel CRM.',
          legal_basis: 'legitimate_interest',
          license_note: meta.licenseNote || null,
          source_url: meta.sourceUrl,
          created_by: meta.createdBy,
        })
        .select('id')
        .single()
      if (error?.code === '23505') return this.ensureProviderSource(org, provider, meta)
      if (error) fail('create_source', error)
      return data.id as string
    },
    async createImportSource(org, meta) {
      const { data, error } = await db
        .from('lead_sources')
        .insert({
          organization_id: org,
          type: 'csv_import',
          provider: 'csv_import',
          name: meta.name,
          description: meta.description,
          legal_basis: meta.legalBasis,
          acquired_at: meta.acquiredAt,
          created_by: meta.createdBy,
        })
        .select('id')
        .single()
      if (error) fail('create_import_source', error)
      return data.id as string
    },
    async insertLead(org, l) {
      const { data, error } = await db
        .from('leads')
        .insert({
          organization_id: org,
          source_id: l.sourceId,
          provider: l.provider,
          external_id: l.externalId,
          dedup_key: l.dedupKey,
          company_name: l.companyName,
          website: l.website,
          phone: l.phone,
          industry: l.industry,
          city: l.city,
          region: l.region,
          country: l.country,
          notes: l.notes,
          score: l.score,
          priority: l.priority,
          score_basis: l.scoreBasis,
          score_breakdown: l.scoreBreakdown,
          score_explanation: l.scoreExplanation,
          acquired_at: l.acquiredAt,
          last_analyzed_at: l.lastAnalyzedAt,
          status: 'new',
          created_by: l.createdBy,
        })
        .select('id')
        .single()
      if (error?.code === '23505') return { ok: false, reason: 'duplicate' }
      if (error?.code === 'P0001' && /contact_suppressed/.test(error.message)) return { ok: false, reason: 'suppressed' }
      if (error) fail('insert_lead', error)
      return { ok: true, id: data.id as string }
    },
    async insertLeadAnalysis(org, leadId, analysis, jobId) {
      const { error } = await db.from('lead_analyses').insert({
        organization_id: org,
        lead_id: leadId,
        ai_job_id: jobId,
        summary: analysis.qualification_reason,
        data: analysis,
        model: analysis.model,
      })
      if (error) fail('insert_lead_analysis', error)
    },
    async createAiJob(row) {
      const { data, error } = await db
        .from('ai_jobs')
        .insert({ organization_id: row.org, candidate_id: row.candidateId, type: 'business_analysis', status: 'queued', input: row.input, created_by: row.createdBy })
        .select('id')
        .single()
      if (error) fail('create_job', error)
      return data.id as string
    },
    async getAiJob(id) {
      const { data, error } = await db.from('ai_jobs').select('id, organization_id, candidate_id, status, input, created_by').eq('id', id).maybeSingle()
      if (error) fail('get_job', error)
      if (!data) return null
      return {
        id: data.id,
        organizationId: data.organization_id,
        candidateId: data.candidate_id,
        status: data.status,
        input: (data.input as Record<string, unknown>) ?? {},
        createdBy: data.created_by,
      } satisfies AiJobRecord
    },
    async updateAiJob(org, id, patch) {
      const row: Row = {}
      if (patch.status) row.status = patch.status
      if ('output' in patch) row.output = patch.output
      if ('error' in patch) row.error = patch.error
      if ('model' in patch) row.model = patch.model
      if (patch.tokensInput !== undefined) row.tokens_input = patch.tokensInput
      if (patch.tokensOutput !== undefined) row.tokens_output = patch.tokensOutput
      if (patch.startedAt) row.started_at = patch.startedAt
      if (patch.completedAt) row.completed_at = patch.completedAt
      if (patch.input) row.input = patch.input
      const { error } = await db.from('ai_jobs').update(row).eq('organization_id', org).eq('id', id)
      if (error) fail('update_job', error)
    },
    async audit(org, actor, action, entityType, entityId, metadata = {}) {
      const { error } = await db.from('audit_logs').insert({ organization_id: org, actor_id: actor, action, entity_type: entityType, entity_id: entityId, metadata })
      if (error) log('warn', 'audit_failed', { action })
    },
  }
}
