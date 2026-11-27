import type { SupabaseClient } from '@supabase/supabase-js'
import { HttpError } from '../http'
import { log } from '../log'
import type { ComboWrite, DemandHunterStore, JobRow, LeadRow, LearningStatWrite, SessionRow, UsageSummary } from './store'
import type { Reading, Verdict } from './types'

/**
 * Implementazione Supabase (service role). Usata SOLO dalle Netlify Functions DOPO requireOrgMember:
 * ogni query filtra comunque per organization_id (difesa in profondità oltre alla RLS).
 */
function fail(op: string, error: { message?: string; code?: string } | null): never {
  log('error', 'demand_hunter.store_error', { op, code: error?.code })
  throw new HttpError(500, 'storage_error')
}

type Row = Record<string, unknown>
const JOB_COLS = 'id, organization_id, kind, status, confirmation_id, service_job_id, mode, params, progress, reserved_calls, spent_searches, spent_autocomplete, usage_settled, error_code, created_by, created_at'
const SESSION_COLS = 'id, organization_id, job_id, goal, seed, budget, status, mode, combos_total, leads_found, events, verbs, objects, created_at, ended_at'
const LEAD_COLS = 'id, organization_id, session_id, url, url_hash, text_hash, text, goal, score, stage, demand, lead_class, taxonomy_node, technology, query, verb, object, status, crm_lead_id, simulated, found_at'

const job = (r: Row): JobRow => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  kind: r.kind as JobRow['kind'],
  status: r.status as JobRow['status'],
  confirmationId: r.confirmation_id as string,
  serviceJobId: (r.service_job_id as string | null) ?? null,
  mode: r.mode as JobRow['mode'],
  params: (r.params as Record<string, unknown>) ?? {},
  progress: (r.progress as Record<string, unknown>) ?? {},
  reservedCalls: Number(r.reserved_calls ?? 0),
  spentSearches: Number(r.spent_searches ?? 0),
  spentAutocomplete: Number(r.spent_autocomplete ?? 0),
  usageSettled: Boolean(r.usage_settled),
  errorCode: (r.error_code as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: r.created_at as string,
})

const session = (r: Row): SessionRow => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  jobId: r.job_id as string,
  goal: r.goal as SessionRow['goal'],
  seed: r.seed as string,
  budget: Number(r.budget),
  status: r.status as SessionRow['status'],
  mode: r.mode as SessionRow['mode'],
  combosTotal: Number(r.combos_total ?? 0),
  leadsFound: Number(r.leads_found ?? 0),
  events: (r.events as unknown[]) ?? [],
  verbs: (r.verbs as unknown[]) ?? [],
  objects: (r.objects as unknown[]) ?? [],
  createdAt: r.created_at as string,
  endedAt: (r.ended_at as string | null) ?? null,
})

function readingFrom(c: Row | undefined): Reading | null {
  if (!c) return null
  return {
    author_role: (c.author_role as string) ?? '',
    demand: '',
    intent_types: (c.intent_types as string[]) ?? [],
    stage: (c.stage as string) ?? '',
    lead_score: Number(c.lead_score ?? 0),
    confidence: Number(c.confidence ?? 0),
    urgency: (c.urgency as string) ?? '',
    budget_declared: Boolean(c.budget_declared),
    specificity: (c.specificity as string) ?? '',
    lead_class: '',
    taxonomy_path: (c.taxonomy_path as string[]) ?? [],
    technology: [],
    evidence: (c.evidence as Reading['evidence']) ?? [],
    reader: (c.reader as string) ?? 'rules',
  }
}

export function createDemandHunterStore(db: SupabaseClient): DemandHunterStore {
  async function decorate(org: string, rows: Row[]): Promise<LeadRow[]> {
    if (!rows.length) return []
    const ids = rows.map((r) => r.id as string)
    const [{ data: cls, error: e1 }, { data: fb, error: e2 }] = await Promise.all([
      db.from('demand_hunter_intent_classifications').select('lead_id, reader, author_role, intent_types, stage, lead_score, confidence, urgency, budget_declared, specificity, taxonomy_path, evidence').eq('organization_id', org).in('lead_id', ids),
      db.from('demand_hunter_feedback').select('lead_id, verdict').eq('organization_id', org).in('lead_id', ids),
    ])
    if (e1) fail('list_classifications', e1)
    if (e2) fail('list_feedback', e2)
    const byLead = new Map((cls ?? []).map((c) => [c.lead_id as string, c as Row]))
    const verdicts = new Map((fb ?? []).map((f) => [f.lead_id as string, f.verdict as Verdict]))
    return rows.map((r) => ({
      id: r.id as string,
      organizationId: r.organization_id as string,
      sessionId: (r.session_id as string | null) ?? null,
      url: r.url as string,
      urlHash: r.url_hash as string,
      textHash: r.text_hash as string,
      text: r.text as string,
      goal: r.goal as LeadRow['goal'],
      score: Number(r.score),
      stage: (r.stage as string | null) ?? null,
      demand: (r.demand as string | null) ?? null,
      leadClass: (r.lead_class as string | null) ?? null,
      taxonomyNode: (r.taxonomy_node as string | null) ?? null,
      technology: (r.technology as string[]) ?? [],
      query: (r.query as string | null) ?? null,
      verb: (r.verb as string | null) ?? null,
      object: (r.object as string | null) ?? null,
      status: r.status as LeadRow['status'],
      crmLeadId: (r.crm_lead_id as string | null) ?? null,
      simulated: Boolean(r.simulated),
      foundAt: r.found_at as string,
      reading: readingFrom(byLead.get(r.id as string)),
      verdict: verdicts.get(r.id as string) ?? null,
    }))
  }

  return {
    async checkRateLimit(org, user, bucket) {
      const { data, error } = await db.rpc('check_rate_limit', { p_org: org, p_user: user, p_bucket: bucket })
      if (error) fail('check_rate_limit', error)
      return data as { allowed: boolean; retry_after?: number }
    },
    async usageSummary(org) {
      const { data, error } = await db.rpc('demand_hunter_usage_summary', { p_org: org })
      if (error) fail('usage_summary', error)
      return data as UsageSummary
    },
    async createConfirmation(row) {
      const { error } = await db.from('demand_hunter_confirmations').insert({
        organization_id: row.org,
        user_id: row.user,
        action: row.action,
        action_key: row.actionKey,
        paid_calls: row.paidCalls,
        token_hash: row.tokenHash,
        expires_at: row.expiresAt,
      })
      if (error) fail('create_confirmation', error)
    },
    async consumeConfirmation(org, user, tokenHash, action, key) {
      const { data, error } = await db.rpc('demand_hunter_consume_confirmation', { p_org: org, p_user: user, p_token_hash: tokenHash, p_action: action, p_action_key: key })
      if (error) fail('consume_confirmation', error)
      const d = data as { ok: boolean; confirmation_id?: string; paid_calls?: number }
      return { ok: d.ok, confirmationId: d.confirmation_id, paidCalls: d.paid_calls }
    },
    async reserve(org, user, jobId, calls, mode) {
      const { data, error } = await db.rpc('demand_hunter_reserve', { p_org: org, p_user: user, p_job: jobId, p_calls: calls, p_mode: mode })
      if (error) fail('reserve', error)
      return data as { allowed: boolean; reason?: string }
    },
    async settle(org, jobId, spent) {
      const { data, error } = await db.rpc('demand_hunter_settle', { p_org: org, p_job: jobId, p_spent: spent })
      if (error) fail('settle', error)
      return { released: Number((data as { released?: number }).released ?? 0) }
    },
    async createJob(row) {
      const { data, error } = await db
        .from('demand_hunter_jobs')
        .insert({ organization_id: row.org, kind: row.kind, confirmation_id: row.confirmationId, mode: row.mode, params: row.params, reserved_calls: row.reservedCalls, created_by: row.createdBy })
        .select(JOB_COLS)
        .single()
      if (error?.code === '23505') throw new HttpError(409, 'duplicate_request')
      if (error) fail('create_job', error)
      return job(data as Row)
    },
    async updateJob(org, id, p) {
      const patch: Row = {}
      if (p.status !== undefined) patch.status = p.status
      if (p.serviceJobId !== undefined) patch.service_job_id = p.serviceJobId
      if (p.progress !== undefined) patch.progress = p.progress
      if (p.spentSearches !== undefined) patch.spent_searches = p.spentSearches
      if (p.spentAutocomplete !== undefined) patch.spent_autocomplete = p.spentAutocomplete
      if (p.errorCode !== undefined) patch.error_code = p.errorCode
      if (p.reservedCalls !== undefined) patch.reserved_calls = p.reservedCalls
      if (p.startedAt !== undefined) patch.started_at = p.startedAt
      if (p.finishedAt !== undefined) patch.finished_at = p.finishedAt
      if (p.syncedAt !== undefined) patch.synced_at = p.syncedAt
      const { error } = await db.from('demand_hunter_jobs').update(patch).eq('organization_id', org).eq('id', id)
      if (error) fail('update_job', error)
    },
    async getJob(org, id) {
      const { data, error } = await db.from('demand_hunter_jobs').select(JOB_COLS).eq('organization_id', org).eq('id', id).maybeSingle()
      if (error) fail('get_job', error)
      return data ? job(data as Row) : null
    },
    async listActiveJobs(limit) {
      const { data, error } = await db.from('demand_hunter_jobs').select(JOB_COLS).in('status', ['queued', 'running']).eq('kind', 'hunt').order('created_at').limit(limit)
      if (error) fail('list_active_jobs', error)
      return (data ?? []).map((r) => job(r as Row))
    },
    async createSession(row) {
      const { data, error } = await db
        .from('demand_hunter_sessions')
        .insert({ organization_id: row.org, job_id: row.jobId, goal: row.goal, seed: row.seed, budget: row.budget, mode: row.mode, created_by: row.createdBy })
        .select(SESSION_COLS)
        .single()
      if (error) fail('create_session', error)
      return session(data as Row)
    },
    async updateSession(org, id, p) {
      const patch: Row = {}
      if (p.status !== undefined) patch.status = p.status
      if (p.combosTotal !== undefined) patch.combos_total = p.combosTotal
      if (p.leadsFound !== undefined) patch.leads_found = p.leadsFound
      if (p.events !== undefined) patch.events = p.events
      if (p.verbs !== undefined) patch.verbs = p.verbs
      if (p.objects !== undefined) patch.objects = p.objects
      if (p.endedAt !== undefined) patch.ended_at = p.endedAt
      const { error } = await db.from('demand_hunter_sessions').update(patch).eq('organization_id', org).eq('id', id)
      if (error) fail('update_session', error)
    },
    async getSessionByJob(org, jobId) {
      const { data, error } = await db.from('demand_hunter_sessions').select(SESSION_COLS).eq('organization_id', org).eq('job_id', jobId).maybeSingle()
      if (error) fail('get_session', error)
      return data ? session(data as Row) : null
    },
    async listSessions(org, limit) {
      const { data, error } = await db.from('demand_hunter_sessions').select(SESSION_COLS).eq('organization_id', org).order('created_at', { ascending: false }).limit(limit)
      if (error) fail('list_sessions', error)
      return (data ?? []).map((r) => session(r as Row))
    },
    async upsertCombinations(org, sessionId, rows) {
      if (!rows.length) return
      const { error } = await db.from('demand_hunter_combinations').upsert(
        rows.map((c) => ({ organization_id: org, session_id: sessionId, query: c.query, verb: c.verb, object: c.object, origin: c.origin, status: c.status, results: c.results, leads: c.leads, priority: c.priority })),
        { onConflict: 'session_id,query' },
      )
      if (error) fail('upsert_combinations', error)
    },
    async listCombinations(org, sessionId, limit) {
      const { data, error } = await db.from('demand_hunter_combinations').select('query, verb, object, origin, status, results, leads, priority').eq('organization_id', org).eq('session_id', sessionId).order('leads', { ascending: false }).order('priority', { ascending: false }).limit(limit)
      if (error) fail('list_combinations', error)
      return (data ?? []).map((c) => ({ ...(c as ComboWrite), priority: Number((c as Row).priority) }))
    },
    async upsertLeads(org, rows) {
      if (!rows.length) return { inserted: 0, duplicates: 0 }
      // Dedup: URL già noti o stesso testo (normalizzato) nella stessa organizzazione → non sono lead nuovi.
      const { data: known, error } = await db
        .from('demand_hunter_leads')
        .select('url_hash, text_hash, goal')
        .eq('organization_id', org)
        .or(`url_hash.in.(${rows.map((r) => r.urlHash).join(',')}),text_hash.in.(${rows.map((r) => r.textHash).join(',')})`)
      if (error) fail('find_leads', error)
      const urls = new Set((known ?? []).map((k) => k.url_hash as string))
      const texts = new Set((known ?? []).map((k) => `${k.goal}:${k.text_hash}`))
      let inserted = 0
      let duplicates = 0
      for (const r of rows) {
        if (urls.has(r.urlHash) || texts.has(`${r.goal}:${r.textHash}`)) {
          duplicates++
          continue
        }
        urls.add(r.urlHash)
        texts.add(`${r.goal}:${r.textHash}`)
        const { data, error: e } = await db
          .from('demand_hunter_leads')
          .insert({ organization_id: org, session_id: r.sessionId, url: r.url, url_hash: r.urlHash, text_hash: r.textHash, text: r.text, goal: r.goal, score: r.score, stage: r.stage, demand: r.demand, lead_class: r.leadClass, taxonomy_node: r.taxonomyNode, technology: r.technology, query: r.query, verb: r.verb, object: r.object, simulated: r.simulated })
          .select('id')
          .single()
        if (e?.code === '23505') {
          duplicates++
          continue
        }
        if (e) fail('insert_lead', e)
        inserted++
        if (r.reading) {
          const rd = r.reading
          const { error: e2 } = await db.from('demand_hunter_intent_classifications').insert({
            organization_id: org,
            lead_id: data.id,
            reader: ['rules', 'claude', 'model'].includes(rd.reader) ? rd.reader : 'rules',
            author_role: rd.author_role || null,
            intent_types: rd.intent_types ?? [],
            stage: rd.stage || null,
            lead_score: rd.lead_score,
            confidence: rd.confidence,
            urgency: rd.urgency || null,
            budget_declared: rd.budget_declared,
            specificity: rd.specificity || null,
            taxonomy_path: rd.taxonomy_path ?? [],
            evidence: (rd.evidence ?? []).slice(0, 12),
          })
          if (e2 && e2.code !== '23505') fail('insert_classification', e2)
        }
      }
      return { inserted, duplicates }
    },
    async listSessionLeads(org, sessionId, limit) {
      const { data, error } = await db.from('demand_hunter_leads').select(LEAD_COLS).eq('organization_id', org).eq('session_id', sessionId).order('score', { ascending: false }).limit(limit)
      if (error) fail('list_leads', error)
      return decorate(org, (data ?? []) as Row[])
    },
    async getLeads(org, ids) {
      if (!ids.length) return []
      const { data, error } = await db.from('demand_hunter_leads').select(LEAD_COLS).eq('organization_id', org).in('id', ids)
      if (error) fail('get_leads', error)
      return decorate(org, (data ?? []) as Row[])
    },
    async setFeedback(org, leadId, verdict, user) {
      if (verdict === null) {
        const { error } = await db.from('demand_hunter_feedback').delete().eq('organization_id', org).eq('lead_id', leadId)
        if (error) fail('delete_feedback', error)
        return
      }
      const { error } = await db
        .from('demand_hunter_feedback')
        .upsert({ organization_id: org, lead_id: leadId, verdict, user_id: user }, { onConflict: 'organization_id,lead_id' })
      if (error) fail('set_feedback', error)
    },
    async markTransferred(org, leadId, crmLeadId) {
      const { error } = await db.from('demand_hunter_leads').update({ status: 'transferred', crm_lead_id: crmLeadId }).eq('organization_id', org).eq('id', leadId)
      if (error) fail('mark_transferred', error)
    },
    async insertConcepts(org, rows) {
      if (!rows.length) return
      const { error } = await db.from('demand_hunter_concepts').upsert(
        rows.map((c) => ({ organization_id: org, goal: c.goal, label: c.label, norm: c.norm, parent_norm: c.parentNorm, rel: c.rel, source: 'autocomplete', job_id: c.jobId })),
        { onConflict: 'organization_id,goal,norm', ignoreDuplicates: true },
      )
      if (error) fail('insert_concepts', error)
    },
    async replaceLearningStats(org, goal, rows) {
      const { error: e1 } = await db.from('demand_hunter_learning_stats').delete().eq('organization_id', org).eq('goal', goal)
      if (e1) fail('clear_learning', e1)
      if (!rows.length) return
      const { error } = await db.from('demand_hunter_learning_stats').insert(rows.slice(0, 2000).map((s) => ({ organization_id: org, ...s, key: s.key.slice(0, 300) })))
      if (error) fail('insert_learning', error)
    },
    async listLearningStats(org, goal) {
      const { data, error } = await db.from('demand_hunter_learning_stats').select('goal, dimension, key, searches, posts, leads, confirmed, wrong, rate, score').eq('organization_id', org).eq('goal', goal).order('score', { ascending: false }).limit(500)
      if (error) fail('list_learning', error)
      return (data ?? []).map((s) => ({ ...(s as LearningStatWrite), rate: Number((s as Row).rate), score: Number((s as Row).score) }))
    },
    async ensureCrmSource(org, user) {
      const { data: found, error: e1 } = await db.from('lead_sources').select('id').eq('organization_id', org).eq('provider', 'demand_hunter').eq('type', 'api').maybeSingle()
      if (e1) fail('find_source', e1)
      if (found) return found.id as string
      const { data, error } = await db
        .from('lead_sources')
        .insert({
          organization_id: org,
          type: 'api',
          provider: 'demand_hunter',
          name: 'Demand Hunter (richieste pubbliche)',
          description: 'Richieste pubbliche individuate tramite ricerca Google (SerpApi) e trasferite manualmente nel CRM.',
          legal_basis: 'legitimate_interest',
          license_note: 'Estratti pubblici mostrati dai risultati di ricerca Google. Nessun accesso diretto a Facebook o LinkedIn.',
          source_url: null,
          created_by: user,
        })
        .select('id')
        .single()
      if (error?.code === '23505') return this.ensureCrmSource(org, user)
      if (error) fail('create_source', error)
      return data.id as string
    },
    async insertCrmLead(org, l) {
      const { data, error } = await db
        .from('leads')
        .insert({
          organization_id: org,
          source_id: l.sourceId,
          provider: 'demand_hunter',
          external_id: l.externalId,
          dedup_key: l.dedupKey,
          company_name: l.companyName,
          industry: l.industry,
          notes: l.notes,
          score: l.score,
          priority: l.priority,
          score_basis: 'rules',
          score_explanation: l.scoreExplanation,
          acquired_at: new Date().toISOString(),
          status: 'new',
          created_by: l.createdBy,
        })
        .select('id')
        .single()
      if (error?.code === '23505') return { ok: false, reason: 'duplicate' }
      if (error?.code === 'P0001' && /contact_suppressed/.test(error.message)) return { ok: false, reason: 'suppressed' }
      if (error) fail('insert_crm_lead', error)
      return { ok: true, id: data.id as string }
    },
    async audit(org, actor, action, entityType, entityId, metadata = {}) {
      const { error } = await db.from('audit_logs').insert({ organization_id: org, actor_id: actor, action, entity_type: entityType, entity_id: entityId, metadata })
      if (error) log('warn', 'audit_failed', { action })
    },
  }
}
