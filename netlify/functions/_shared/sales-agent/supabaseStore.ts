import type { SupabaseClient } from '@supabase/supabase-js'
import { HttpError } from '../http'
import { log } from '../log'
import type { LeadRaw, SalesProfile, SalesService } from './context'
import type { CopilotSnapshot, SalesJob, SalesStore } from './store'
import type { QuotaResult } from '../lead-finder/store'

/**
 * Implementazione Supabase (service role). Il service role bypassa RLS: ogni query
 * filtra esplicitamente per organization_id, verificato prima dal chiamante.
 */
function fail(op: string, error: { code?: string } | null): never {
  log('error', 'sales_store_error', { op, code: error?.code })
  throw new HttpError(500, 'storage_error')
}

type Row = Record<string, unknown>

export function mapProfile(org: string, r: Row | null): SalesProfile {
  return {
    organizationId: org,
    commercialName: (r?.commercial_name as string) || null,
    sector: (r?.sector as string) || null,
    offerDescription: (r?.offer_description as string) || null,
    services: ((r?.services as SalesService[]) ?? []).filter((s) => s && s.id && s.name),
    priceRange: (r?.price_range as string) || null,
    currency: (r?.currency as string) || 'EUR',
    servedAreas: (r?.served_areas as string[]) ?? [],
    idealCustomer: (r?.ideal_customer as string) || null,
    differentiators: (r?.differentiators as string[]) ?? [],
    website: (r?.website as string) || null,
    language: (r?.language as 'it' | 'en') ?? 'it',
    tone: (r?.tone as SalesProfile['tone']) ?? 'consultative',
    callToAction: (r?.call_to_action as string) || null,
    bookingUrl: (r?.booking_url as string) || null,
    commercialTerms: (r?.commercial_terms as string) || null,
    followUpDays: (r?.follow_up_days as number[]) ?? [3, 7, 14],
  }
}

export function createSalesStore(db: SupabaseClient): SalesStore {
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
    async countInflight(org) {
      const { count, error } = await db
        .from('ai_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', org)
        .in('type', ['sales_agent', 'follow_up'])
        .in('status', ['queued', 'running'])
      if (error) fail('count_inflight', error)
      return count ?? 0
    },
    async getProfile(org) {
      const { data, error } = await db.from('sales_profiles').select('*').eq('organization_id', org).maybeSingle()
      if (error) fail('get_profile', error)
      return mapProfile(org, data as Row | null)
    },
    async getLead(org, leadId) {
      const { data: lead, error } = await db
        .from('leads')
        .select('id, company_name, website, phone, industry, city, region, country, status, contact_status, score, priority, score_breakdown, last_activity_at, created_at, deleted_at, source:lead_sources(name, type, legal_basis, provider)')
        .eq('organization_id', org)
        .eq('id', leadId)
        .maybeSingle()
      if (error) fail('get_lead', error)
      if (!lead) return null
      const [analyses, activities, opp, proposals, tasks] = await Promise.all([
        db.from('lead_analyses').select('kind, data, created_at').eq('organization_id', org).eq('lead_id', leadId).order('created_at', { ascending: false }).limit(10),
        db.from('activities').select('type, subject, occurred_at').eq('organization_id', org).eq('lead_id', leadId).order('occurred_at', { ascending: false }).limit(10),
        db.from('sales_opportunities').select('title, service_name, value_amount, currency, status').eq('organization_id', org).eq('lead_id', leadId).eq('status', 'open').maybeSingle(),
        db.from('sales_proposals').select('title, status, created_at').eq('organization_id', org).eq('lead_id', leadId).order('created_at', { ascending: false }).limit(5),
        db.from('follow_up_tasks').select('kind, title, due_at, status').eq('organization_id', org).eq('lead_id', leadId).eq('status', 'open').order('due_at').limit(5),
      ])
      for (const r of [analyses, activities, opp, proposals, tasks]) if (r.error) fail('get_lead_related', r.error)
      const a = (analyses.data ?? []) as { kind: string; data: Record<string, unknown> }[]
      const { source: src, ...rest } = lead as unknown as Row & { source: LeadRaw['source'] | LeadRaw['source'][] }
      // La relazione molti-a-uno arriva come oggetto (o array, a seconda dei tipi generati).
      const source = Array.isArray(src) ? (src[0] ?? null) : (src ?? null)
      return {
        lead: rest as unknown as LeadRaw['lead'],
        source,
        businessAnalysis: a.find((x) => x.kind === 'business_analysis')?.data ?? null,
        intelligence: a.find((x) => x.kind === 'sales_intelligence')?.data ?? null,
        activities: (activities.data ?? []) as LeadRaw['activities'],
        opportunity: (opp.data as LeadRaw['opportunity']) ?? null,
        proposals: (proposals.data ?? []) as LeadRaw['proposals'],
        openTasks: (tasks.data ?? []) as LeadRaw['openTasks'],
      }
    },
    async getFollowUpTask(org, id) {
      const { data, error } = await db.from('follow_up_tasks').select('id, lead_id, kind, title, notes, due_at, status').eq('organization_id', org).eq('id', id).maybeSingle()
      if (error) fail('get_follow_up', error)
      return data as never
    },
    async getCopilotSnapshot(org) {
      const now = Date.now()
      const [leads, stages, tasks, opps] = await Promise.all([
        db
          .from('leads')
          .select('id, company_name, industry, city, status, score, priority, contact_status, last_activity_at, created_at')
          .eq('organization_id', org)
          .is('deleted_at', null)
          .order('score', { ascending: false, nullsFirst: false })
          .order('updated_at', { ascending: false })
          .limit(60),
        db.from('leads').select('status').eq('organization_id', org).is('deleted_at', null).limit(5000),
        db.from('follow_up_tasks').select('lead_id, title, due_at').eq('organization_id', org).eq('status', 'open').order('due_at').limit(30),
        db.from('sales_opportunities').select('lead_id, title, service_name, value_amount, currency').eq('organization_id', org).eq('status', 'open').limit(30),
      ])
      for (const r of [leads, stages, tasks, opps]) if (r.error) fail('snapshot', r.error)
      const ids = (leads.data ?? []).map((l) => l.id as string)
      const analysed = new Set<string>()
      if (ids.length) {
        const { data } = await db.from('lead_analyses').select('lead_id').eq('organization_id', org).eq('kind', 'business_analysis').in('lead_id', ids)
        for (const r of data ?? []) analysed.add(r.lead_id as string)
      }
      const byStage: Record<string, number> = {}
      for (const r of stages.data ?? []) byStage[r.status as string] = (byStage[r.status as string] ?? 0) + 1
      const snapshot: CopilotSnapshot = {
        generated_at: new Date(now).toISOString(),
        by_stage: byStage,
        leads: (leads.data ?? []).map((l) => {
          const ref = (l.last_activity_at as string) ?? (l.created_at as string)
          return {
            id: l.id as string,
            company_name: l.company_name as string,
            industry: (l.industry as string) ?? null,
            city: (l.city as string) ?? null,
            stage: l.status as string,
            score: (l.score as number) ?? null,
            priority: (l.priority as string) ?? null,
            contactable: l.contact_status === 'active' && l.status !== 'not_contactable',
            days_since_activity: ref ? Math.floor((now - new Date(ref).getTime()) / 86_400_000) : null,
            has_business_analysis: analysed.has(l.id as string),
          }
        }),
        due_follow_ups: (tasks.data ?? []).map((t) => ({ lead_id: t.lead_id as string, title: t.title as string, due_at: t.due_at as string, overdue: new Date(t.due_at as string).getTime() < now })),
        open_opportunities: (opps.data ?? []) as CopilotSnapshot['open_opportunities'],
      }
      return snapshot
    },
    async getConversation(org, id) {
      const { data, error } = await db.from('ai_conversations').select('id, user_id, lead_id, archived_at').eq('organization_id', org).eq('id', id).maybeSingle()
      if (error) fail('get_conversation', error)
      return data as never
    },
    async getConversationMessages(org, conversationId, limit) {
      const { data, error } = await db
        .from('ai_messages')
        .select('id, role, content, created_at')
        .eq('organization_id', org)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) fail('get_messages', error)
      return ((data ?? []) as { id: string; role: 'user' | 'assistant'; content: string }[]).reverse()
    },
    async createConversation(org, userId, title, leadId) {
      const { data, error } = await db.from('ai_conversations').insert({ organization_id: org, user_id: userId, title, lead_id: leadId }).select('id').single()
      if (error) fail('create_conversation', error)
      return data.id as string
    },
    async insertUserMessage(org, conversationId, content) {
      const { data, error } = await db.from('ai_messages').insert({ organization_id: org, conversation_id: conversationId, role: 'user', content }).select('id').single()
      if (error) fail('insert_user_message', error)
      return data.id as string
    },
    async createJob(row) {
      const { data, error } = await db
        .from('ai_jobs')
        .insert({
          organization_id: row.org,
          type: row.task === 'follow_up_suggestion' ? 'follow_up' : 'sales_agent',
          task: row.task,
          lead_id: row.leadId,
          status: 'queued',
          input: row.input,
          created_by: row.createdBy,
        })
        .select('id')
        .single()
      if (error) fail('create_job', error)
      return data.id as string
    },
    async getJob(id) {
      const { data, error } = await db.from('ai_jobs').select('id, organization_id, status, task, lead_id, input, created_by').eq('id', id).maybeSingle()
      if (error) fail('get_job', error)
      if (!data || !data.task || data.task === 'business_analysis') return null
      return {
        id: data.id,
        organizationId: data.organization_id,
        status: data.status,
        task: data.task,
        leadId: data.lead_id,
        input: (data.input as Record<string, unknown>) ?? {},
        createdBy: data.created_by,
      } satisfies SalesJob
    },
    async updateJob(org, id, p) {
      const row: Row = {}
      if (p.status) row.status = p.status
      if ('output' in p) row.output = p.output
      if ('error' in p) row.error = p.error
      if ('model' in p) row.model = p.model
      if (p.tokensInput !== undefined) row.tokens_input = p.tokensInput
      if (p.tokensOutput !== undefined) row.tokens_output = p.tokensOutput
      if ('costUsd' in p) row.cost_usd = p.costUsd
      if (p.startedAt) row.started_at = p.startedAt
      if (p.completedAt) row.completed_at = p.completedAt
      const { error } = await db.from('ai_jobs').update(row).eq('organization_id', org).eq('id', id)
      if (error) fail('update_job', error)
    },
    async insertDrafts(org, rows) {
      const { data, error } = await db
        .from('message_drafts')
        .insert(
          rows.map((r) => ({
            organization_id: org,
            lead_id: r.leadId,
            channel: r.channel,
            variant: r.variant,
            generation_id: r.generationId,
            subject: r.subject,
            body: r.body,
            facts_used: r.factsUsed,
            warnings: r.warnings,
            generated_by: 'ai',
            ai_job_id: r.aiJobId,
            follow_up_task_id: r.followUpTaskId,
            created_by: r.createdBy,
          })),
        )
        .select('id')
      if (error) fail('insert_drafts', error)
      return (data ?? []).map((d) => d.id as string)
    },
    async insertProposal(org, r) {
      const { data, error } = await db
        .from('sales_proposals')
        .insert({
          organization_id: org,
          lead_id: r.leadId,
          title: r.title,
          variant: r.variant,
          language: r.language,
          content: r.content,
          facts_used: r.factsUsed,
          warnings: r.warnings,
          generated_by: 'ai',
          ai_job_id: r.aiJobId,
          created_by: r.createdBy,
        })
        .select('id')
        .single()
      if (error) fail('insert_proposal', error)
      return data.id as string
    },
    async insertIntelligence(org, leadId, data_, jobId, model) {
      const { data, error } = await db
        .from('lead_analyses')
        .insert({ organization_id: org, lead_id: leadId, kind: 'sales_intelligence', ai_job_id: jobId, model, summary: String(data_.fit_summary ?? '').slice(0, 2000), data: data_ })
        .select('id')
        .single()
      if (error) fail('insert_intelligence', error)
      return data.id as string
    },
    async setFollowUpSuggestion(org, taskId, suggestion) {
      const { error } = await db.from('follow_up_tasks').update({ ai_suggestion: suggestion }).eq('organization_id', org).eq('id', taskId)
      if (error) fail('set_follow_up_suggestion', error)
    },
    async insertAssistantMessage(org, conversationId, r) {
      const { data, error } = await db
        .from('ai_messages')
        .insert({ organization_id: org, conversation_id: conversationId, role: 'assistant', content: r.content, structured: r.structured, ai_job_id: r.jobId, model: r.model, tokens_input: r.tokensInput, tokens_output: r.tokensOutput })
        .select('id')
        .single()
      if (error) fail('insert_assistant_message', error)
      await db.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('organization_id', org).eq('id', conversationId)
      return data.id as string
    },
    async logActivity(org, leadId, actor, subject, metadata) {
      const { error } = await db.from('activities').insert({ organization_id: org, lead_id: leadId, type: 'ai', subject, metadata, created_by: actor })
      if (error) log('warn', 'sales_activity_failed', { code: error.code })
    },
    async getCampaignForContent(org, campaignId, position) {
      const { data: c, error } = await db
        .from('campaigns')
        .select('id, name, status, goal, service_name, language, channel, call_to_action, description, sequence:campaign_sequences(id)')
        .eq('organization_id', org)
        .eq('id', campaignId)
        .maybeSingle()
      if (error) fail('get_campaign', error)
      if (!c) return null
      const seq = (Array.isArray(c.sequence) ? c.sequence[0] : c.sequence) as { id: string } | null
      if (!seq) return null
      const { data: st, error: e2 } = await db.from('campaign_steps').select('id, position, kind, day_offset').eq('organization_id', org).eq('sequence_id', seq.id).eq('position', position).maybeSingle()
      if (e2) fail('get_step', e2)
      if (!st) return null
      const { data: rec, error: e3 } = await db
        .from('campaign_recipients')
        .select('status, lead:leads(industry, country, city, contact_name)')
        .eq('organization_id', org)
        .eq('campaign_id', campaignId)
        .in('status', ['eligible', 'pending', 'in_sequence'])
        .limit(2000)
      if (e3) fail('get_audience', e3)
      const count = (vals: (string | null)[]) => {
        const m = new Map<string, number>()
        for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1)
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, count: n }))
      }
      const leads = (rec ?? []).map((r) => (Array.isArray(r.lead) ? r.lead[0] : r.lead) as { industry: string | null; country: string | null; city: string | null; contact_name: string | null } | null).filter(Boolean) as { industry: string | null; country: string | null; city: string | null; contact_name: string | null }[]
      return {
        campaign: { id: c.id, name: c.name, status: c.status, goal: c.goal, service_name: c.service_name, language: c.language, channel: c.channel, call_to_action: c.call_to_action, description: c.description },
        step: st,
        audience: {
          recipients: leads.length,
          with_contact_name: leads.filter((l) => l.contact_name).length,
          industries: count(leads.map((l) => l.industry)),
          countries: count(leads.map((l) => l.country)),
          cities: count(leads.map((l) => l.city)),
        },
      }
    },
    async saveStepVariants(org, stepId, variants, warnings, jobId) {
      const { error } = await db.from('campaign_steps').update({ ai_variants: variants, ai_warnings: warnings, ai_job_id: jobId }).eq('organization_id', org).eq('id', stepId)
      if (error) fail('save_step_variants', error)
    },
    async getInbound(org, id) {
      const { data, error } = await db
        .from('inbound_messages')
        .select('id, lead_id, from_email, subject, body_text, received_at, outbound:outbound_messages!inbound_messages_organization_id_outbound_message_id_fkey(subject, body_text)')
        .eq('organization_id', org)
        .eq('id', id)
        .maybeSingle()
      if (error) fail('get_inbound', error)
      if (!data) return null
      const o = (Array.isArray(data.outbound) ? data.outbound[0] : data.outbound) as { subject: string; body_text: string } | null
      return { id: data.id, lead_id: data.lead_id, from_email: data.from_email, subject: data.subject, body_text: data.body_text, received_at: data.received_at, original: o ?? null }
    },
    async saveInboundAnalysis(org, id, a) {
      const { error } = await db
        .from('inbound_messages')
        .update({ ai_classification: a.classification, ai_summary: a.summary, ai_suggested_reply: a.suggested_reply, ai_needs_human: a.needs_human, ai_job_id: a.jobId })
        .eq('organization_id', org)
        .eq('id', id)
      if (error) fail('save_inbound_analysis', error)
      // Disiscrizione riconosciuta dall'AI: si registra subito l'opposizione (scelta prudente,
      // un admin può revocarla); la classificazione resta modificabile da una persona.
      if (a.classification === 'unsubscribe') {
        const { data } = await db.from('inbound_messages').select('lead_id').eq('id', id).maybeSingle()
        if (data?.lead_id) await db.from('leads').update({ contact_status: 'opted_out' }).eq('organization_id', org).eq('id', data.lead_id).eq('contact_status', 'active')
      }
    },
  }
}
