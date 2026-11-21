import type { SupabaseClient } from '@supabase/supabase-js'
import { HttpError } from '../http'
import { log } from '../log'
import { billingDbError } from '../billing/access'
import { fold } from '../lead-finder/normalize'
import type { AgentStore, FollowUpSnapshot, GrowthMetrics, MemoryEntry } from './store'
import type { AgentConfig, AgentKey, ApprovalRecord, EvidenceWrite, StepRecord, WorkflowRecord } from './types'

/**
 * AgentStore su Supabase con la service role. Usato SOLO dopo i controlli di autorizzazione
 * (endpoint) o dal motore su workflow già autorizzati. Ogni query filtra per organizzazione.
 */
type Row = Record<string, unknown>

function fail(op: string, error: { code?: string; message?: string } | null): never {
  log('error', 'agent_store_error', { op, code: error?.code })
  throw new HttpError(500, 'storage_error')
}

const CONTACT_STAGES = ['to_contact', 'contacted', 'in_conversation', 'meeting_scheduled', 'proposal_sent', 'negotiation', 'not_contactable']

function mapWorkflow(r: Row): WorkflowRecord {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    template: r.template as WorkflowRecord['template'],
    objective: (r.objective as string | null) ?? null,
    params: (r.params as Record<string, unknown>) ?? {},
    status: r.status as WorkflowRecord['status'],
    budgetCredits: Number(r.budget_credits ?? 0),
    creditsUsed: Number(r.credits_used ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    maxRuntimeSeconds: Number(r.max_runtime_seconds ?? 1800),
    deadlineAt: (r.deadline_at as string | null) ?? null,
    cancelRequestedAt: (r.cancel_requested_at as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    resumeCount: Number(r.resume_count ?? 0),
    startedAt: (r.started_at as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    report: (r.report as Record<string, unknown> | null) ?? null,
    createdAt: r.created_at as string,
  }
}

function mapStep(r: Row): StepRecord {
  return {
    id: r.id as string,
    workflowId: r.workflow_id as string,
    organizationId: r.organization_id as string,
    position: Number(r.position),
    agentKey: r.agent_key as AgentKey,
    action: r.action as StepRecord['action'],
    dependsOn: ((r.depends_on as number[]) ?? []).map(Number),
    requiresApproval: !!r.requires_approval,
    status: r.status as StepRecord['status'],
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.max_attempts ?? 2),
    timeoutSeconds: Number(r.timeout_seconds ?? 600),
    input: (r.input as Record<string, unknown>) ?? {},
    output: (r.output as Record<string, unknown> | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
  }
}

const evidenceRow = (org: string, e: EvidenceWrite): Row => ({
  organization_id: org,
  workflow_id: e.workflowId,
  run_id: e.runId,
  subject_type: e.subjectType,
  subject_id: e.subjectId,
  category: e.category,
  kind: e.kind,
  statement: e.statement.slice(0, 1000),
  evidence: e.evidence ? e.evidence.slice(0, 1000) : null,
  source_type: e.sourceType,
  source_url: e.sourceUrl,
  observed_at: e.observedAt,
  rationale: e.rationale ? e.rationale.slice(0, 1000) : null,
})

export function createAgentStore(db: SupabaseClient): AgentStore {
  return {
    async getAgentConfigs(org) {
      const { data, error } = await db.from('ai_agents').select('agent_key, enabled, model_tier, monthly_credit_budget, max_credits_per_run, config').eq('organization_id', org)
      if (error) fail('get_agent_configs', error)
      return (data ?? []).map(
        (r) =>
          ({
            agentKey: r.agent_key,
            enabled: r.enabled,
            modelTier: r.model_tier,
            monthlyCreditBudget: r.monthly_credit_budget,
            maxCreditsPerRun: r.max_credits_per_run,
            config: (r.config as Record<string, number>) ?? {},
          }) as AgentConfig,
      )
    },
    async getCreditCosts() {
      const { data, error } = await db.from('ai_credit_costs').select('ai_task, credits').not('ai_task', 'is', null)
      if (error) fail('get_credit_costs', error)
      return Object.fromEntries((data ?? []).map((r) => [r.ai_task as string, Number(r.credits)]))
    },
    async getMonthlySpend(org, fromIso) {
      const { data, error } = await db.rpc('ai_agent_spend', { p_org: org, p_from: fromIso })
      if (error) fail('get_spend', error)
      const d = (data ?? {}) as { credits?: number; by_agent?: Record<string, { credits: number }> }
      return { credits: Number(d.credits ?? 0), byAgent: Object.fromEntries(Object.entries(d.by_agent ?? {}).map(([k, v]) => [k, Number(v.credits ?? 0)])) }
    },

    async createWorkflow(row) {
      const { data, error } = await db
        .from('ai_workflows')
        .insert({
          organization_id: row.org,
          template: row.template,
          objective: row.objective,
          params: row.params,
          idempotency_key: row.idempotencyKey,
          budget_credits: row.budgetCredits,
          max_runtime_seconds: row.maxRuntimeSeconds,
          created_by: row.createdBy,
        })
        .select('*')
        .single()
      if (error) {
        if (error.code === '23505') {
          // Idempotenza: stessa chiave → stesso workflow, nessuna nuova esecuzione.
          const { data: existing, error: e2 } = await db.from('ai_workflows').select('*').eq('organization_id', row.org).eq('idempotency_key', row.idempotencyKey).single()
          if (e2) fail('get_existing_workflow', e2)
          return { workflow: mapWorkflow(existing as Row), created: false }
        }
        // Trigger ai_workflows_concurrency_guard (migrazione 0013): troppi workflow attivi per l'organizzazione.
        if (error.message?.includes('too_many_active_workflows')) throw new HttpError(409, 'too_many_active_workflows')
        fail('create_workflow', error)
      }
      const wf = mapWorkflow(data as Row)
      const { error: se } = await db.from('ai_workflow_steps').insert(
        row.steps.map((s) => ({
          organization_id: row.org,
          workflow_id: wf.id,
          position: s.position,
          agent_key: s.agentKey,
          action: s.action,
          depends_on: s.dependsOn,
          requires_approval: s.requiresApproval,
          max_attempts: s.maxAttempts,
          timeout_seconds: s.timeoutSeconds,
          input: s.input,
        })),
      )
      if (se) {
        await db.from('ai_workflows').update({ status: 'failed', error_code: 'plan_insert_failed', completed_at: new Date().toISOString() }).eq('id', wf.id)
        fail('create_steps', se)
      }
      return { workflow: wf, created: true }
    },
    async getWorkflow(id) {
      const { data, error } = await db.from('ai_workflows').select('*').eq('id', id).maybeSingle()
      if (error) fail('get_workflow', error)
      return data ? mapWorkflow(data as Row) : null
    },
    async getSteps(org, workflowId) {
      const { data, error } = await db.from('ai_workflow_steps').select('*').eq('organization_id', org).eq('workflow_id', workflowId).order('position')
      if (error) fail('get_steps', error)
      return (data ?? []).map((r) => mapStep(r as Row))
    },
    async claimWorkflow(id, token, leaseSeconds) {
      const now = new Date()
      const { data, error } = await db
        .from('ai_workflows')
        .update({ lock_token: token, locked_until: new Date(now.getTime() + leaseSeconds * 1000).toISOString(), status: 'running' })
        .eq('id', id)
        .in('status', ['pending', 'running'])
        .or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`)
        .select('*')
      if (error) fail('claim_workflow', error)
      return data && data.length ? mapWorkflow(data[0] as Row) : null
    },
    async renewLease(org, id, token, leaseSeconds) {
      const { data, error } = await db
        .from('ai_workflows')
        .update({ locked_until: new Date(Date.now() + leaseSeconds * 1000).toISOString() })
        .eq('organization_id', org)
        .eq('id', id)
        .eq('lock_token', token)
        .select('id')
      if (error) fail('renew_lease', error)
      return !!data?.length
    },
    async updateWorkflow(org, id, token, patch) {
      const row: Row = {}
      if (patch.status) row.status = patch.status
      if (patch.creditsUsed !== undefined) row.credits_used = patch.creditsUsed
      if (patch.costUsd !== undefined) row.cost_usd = patch.costUsd
      if (patch.errorCode !== undefined) row.error_code = patch.errorCode
      if (patch.report !== undefined) row.report = patch.report
      if (patch.startedAt) row.started_at = patch.startedAt
      if (patch.completedAt) row.completed_at = patch.completedAt
      if (patch.deadlineAt) row.deadline_at = patch.deadlineAt
      if (patch.resumeCount !== undefined) row.resume_count = patch.resumeCount
      const { data, error } = await db.from('ai_workflows').update(row).eq('organization_id', org).eq('id', id).eq('lock_token', token).select('id')
      if (error) fail('update_workflow', error)
      return !!data?.length
    },
    async releaseWorkflow(org, id, token, patch) {
      const row: Row = { lock_token: null, locked_until: null }
      if (patch.status) row.status = patch.status
      if (patch.creditsUsed !== undefined) row.credits_used = patch.creditsUsed
      if (patch.costUsd !== undefined) row.cost_usd = patch.costUsd
      if (patch.errorCode !== undefined) row.error_code = patch.errorCode
      if (patch.report !== undefined) row.report = patch.report
      if (patch.completedAt) row.completed_at = patch.completedAt
      if (patch.resumeCount !== undefined) row.resume_count = patch.resumeCount
      const { error } = await db.from('ai_workflows').update(row).eq('organization_id', org).eq('id', id).eq('lock_token', token)
      if (error) fail('release_workflow', error)
    },
    async isCancelRequested(org, id) {
      const { data, error } = await db.from('ai_workflows').select('cancel_requested_at, status').eq('organization_id', org).eq('id', id).maybeSingle()
      if (error) fail('is_cancel_requested', error)
      return !!data?.cancel_requested_at || data?.status === 'cancelled'
    },
    async updateStep(org, stepId, patch) {
      const row: Row = {}
      if (patch.status) row.status = patch.status
      if (patch.attempts !== undefined) row.attempts = patch.attempts
      if (patch.output !== undefined) row.output = patch.output
      if (patch.errorCode !== undefined) row.error_code = patch.errorCode
      if (patch.startedAt) row.started_at = patch.startedAt
      if (patch.completedAt !== undefined) row.completed_at = patch.completedAt
      const { error } = await db.from('ai_workflow_steps').update(row).eq('organization_id', org).eq('id', stepId)
      if (error) fail('update_step', error)
    },
    async createRun(row) {
      const { data, error } = await db
        .from('ai_agent_runs')
        .insert({ organization_id: row.org, workflow_id: row.workflowId, step_id: row.stepId, agent_key: row.agentKey, attempt: row.attempt, input_summary: row.inputSummary, created_by: row.createdBy })
        .select('id')
        .single()
      if (error) {
        if (error.code === '23505' && row.stepId) {
          const { data: ex } = await db.from('ai_agent_runs').select('id').eq('organization_id', row.org).eq('step_id', row.stepId).eq('attempt', row.attempt).single()
          if (ex) return ex.id as string
        }
        fail('create_run', error)
      }
      return data.id as string
    },
    async finishRun(org, runId, patch) {
      const row: Row = { status: patch.status, completed_at: new Date().toISOString() }
      if (patch.output !== undefined) row.output = patch.output
      if (patch.errorCode !== undefined) row.error_code = patch.errorCode
      if (patch.itemsTotal !== undefined) row.items_total = patch.itemsTotal
      if (patch.itemsFailed !== undefined) row.items_failed = patch.itemsFailed
      if (patch.creditsUsed !== undefined) row.credits_used = Math.max(0, patch.creditsUsed)
      if (patch.tokensInput !== undefined) row.tokens_input = patch.tokensInput
      if (patch.tokensOutput !== undefined) row.tokens_output = patch.tokensOutput
      if (patch.costUsd !== undefined) row.cost_usd = patch.costUsd
      if (patch.model !== undefined) row.model = patch.model
      const { error } = await db.from('ai_agent_runs').update(row).eq('organization_id', org).eq('id', runId)
      if (error) fail('finish_run', error)
    },
    async recordToolCall(org, r) {
      const { error } = await db.from('ai_agent_tool_calls').insert({
        organization_id: org,
        run_id: r.runId || null,
        workflow_id: r.workflowId,
        agent_key: r.agentKey,
        tool: r.tool,
        outcome: r.outcome,
        denied_reason: r.deniedReason,
        error_code: r.errorCode,
        args_summary: r.argsSummary,
        result_summary: r.resultSummary,
        duration_ms: r.durationMs,
      })
      if (error) fail('record_tool_call', error)
    },
    async createApproval(row) {
      const expires = new Date(Date.now() + row.expiresHours * 3_600_000).toISOString()
      const { data, error } = await db
        .from('ai_agent_approvals')
        .insert({ organization_id: row.org, workflow_id: row.workflowId, step_id: row.stepId, action: row.action, summary: row.summary, expires_at: expires })
        .select('id')
        .single()
      if (error) fail('create_approval', error)
      return data.id as string
    },
    async getApproval(org, id) {
      const { data, error } = await db.from('ai_agent_approvals').select('*').eq('organization_id', org).eq('id', id).maybeSingle()
      if (error) fail('get_approval', error)
      if (!data) return null
      return {
        id: data.id,
        organizationId: data.organization_id,
        workflowId: data.workflow_id,
        stepId: data.step_id,
        action: data.action,
        status: data.status,
        decidedBy: data.decided_by,
        expiresAt: data.expires_at,
        summary: (data.summary as Record<string, unknown>) ?? {},
      } satisfies ApprovalRecord
    },
    async expireApprovals() {
      const { data, error } = await db.from('ai_agent_approvals').update({ status: 'expired' }).eq('status', 'pending').lt('expires_at', new Date().toISOString()).select('workflow_id, step_id, organization_id')
      if (error) fail('expire_approvals', error)
      for (const a of data ?? []) {
        await db.from('ai_workflow_steps').update({ status: 'skipped', error_code: 'approval_expired', completed_at: new Date().toISOString() }).eq('id', a.step_id).eq('status', 'waiting_approval')
        // Pronto per la chiusura da parte del motore (report con esito parziale).
        await db.from('ai_workflows').update({ status: 'pending', lock_token: null, locked_until: null }).eq('id', a.workflow_id).eq('status', 'waiting_approval')
      }
      return [...new Set((data ?? []).map((a) => a.workflow_id as string))]
    },
    async listResumable(limit) {
      const now = new Date().toISOString()
      const { data, error } = await db.from('ai_workflows').select('id').or(`status.eq.pending,and(status.eq.running,locked_until.lt.${now})`).order('created_at').limit(limit)
      if (error) fail('list_resumable', error)
      return (data ?? []).map((r) => r.id as string)
    },

    async insertEvidence(org, rows) {
      if (!rows.length) return 0
      const { error } = await db.from('ai_research_evidence').insert(rows.map((e) => evidenceRow(org, e)))
      if (error) fail('insert_evidence', error)
      return rows.length
    },
    async listEvidence(org, subjectType, subjectId, limit) {
      const { data, error } = await db
        .from('ai_research_evidence')
        .select('*')
        .eq('organization_id', org)
        .eq('subject_type', subjectType)
        .eq('subject_id', subjectId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) fail('list_evidence', error)
      return (data ?? []).map((r) => ({
        workflowId: r.workflow_id,
        runId: r.run_id,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        category: r.category,
        kind: r.kind,
        statement: r.statement,
        evidence: r.evidence,
        sourceType: r.source_type,
        sourceUrl: r.source_url,
        observedAt: r.observed_at,
        rationale: r.rationale,
      }))
    },
    async recordCost(org, c) {
      const { error } = await db.from('ai_agent_costs').insert({
        organization_id: org,
        workflow_id: c.workflowId,
        run_id: c.runId || null,
        agent_key: c.agentKey,
        kind: c.kind,
        ai_job_id: c.aiJobId,
        model: c.model,
        tokens_input: c.tokensInput,
        tokens_output: c.tokensOutput,
        credits: c.credits,
        cost_usd: c.costUsd,
        cache_hit: c.cacheHit,
      })
      if (error) fail('record_cost', error)
    },
    async getMemory(org, categories, limit) {
      const { data, error } = await db
        .from('ai_company_memory')
        .select('category, entry_key, version, content')
        .eq('organization_id', org)
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString())
        .in('category', categories)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) fail('get_memory', error)
      return (data ?? []) as MemoryEntry[]
    },
    async audit(org, actor, action, entityType, entityId, metadata = {}) {
      const { error } = await db.from('audit_logs').insert({ organization_id: org, actor_id: actor, action, entity_type: entityType, entity_id: entityId, metadata })
      if (error) log('warn', 'agent_audit_failed', { action })
    },

    async createAiJob(row) {
      const { data, error } = await db
        .from('ai_jobs')
        .insert({ organization_id: row.org, type: row.type, task: row.task, lead_id: row.leadId, status: 'running', input: row.input, created_by: row.createdBy, started_at: new Date().toISOString() })
        .select('id')
        .single()
      // Il trigger di billing rifiuta il job se mancano piano o crediti; il cost guard se è superato un tetto di spesa.
      if (error) throw billingDbError(error) ?? fail('create_ai_job', error)
      return data.id as string
    },
    async finishAiJob(org, id, patch) {
      const row: Row = { status: patch.status, completed_at: new Date().toISOString() }
      if (patch.error !== undefined) row.error = patch.error
      if (patch.model !== undefined) row.model = patch.model
      if (patch.tokensInput !== undefined) row.tokens_input = patch.tokensInput
      if (patch.tokensOutput !== undefined) row.tokens_output = patch.tokensOutput
      if (patch.costUsd !== undefined) row.cost_usd = patch.costUsd
      if (patch.output !== undefined) row.output = patch.output
      const { error } = await db.from('ai_jobs').update(row).eq('organization_id', org).eq('id', id)
      if (error) fail('finish_ai_job', error)
    },
    async findRecentStrategy(org, leadId, inputHash, sinceIso) {
      const { data, error } = await db
        .from('ai_jobs')
        .select('output')
        .eq('organization_id', org)
        .eq('task', 'sales_strategy')
        .eq('lead_id', leadId)
        .eq('status', 'succeeded')
        .gte('created_at', sinceIso)
        .eq('output->>input_hash', inputHash)
        .order('created_at', { ascending: false })
        .limit(1)
      if (error) fail('find_recent_strategy', error)
      const out = data?.[0]?.output as { strategy?: Record<string, unknown> } | undefined
      return out?.strategy ?? null
    },

    async listCandidatesBySearch(org, searchId, limit) {
      const { data, error } = await db
        .from('lead_candidates')
        .select('id')
        .eq('organization_id', org)
        .eq('search_id', searchId)
        .order('score', { ascending: false, nullsFirst: false })
        .limit(limit)
      if (error) fail('list_candidates_by_search', error)
      return (data ?? []).map((r) => r.id as string)
    },
    async sectorHistory(org) {
      const { data, error } = await db.from('leads').select('industry, status').eq('organization_id', org).is('deleted_at', null).in('status', ['won', 'lost']).limit(5000)
      if (error) fail('sector_history', error)
      const out: Record<string, { won: number; lost: number }> = {}
      for (const r of data ?? []) {
        if (!r.industry) continue
        const k = fold(r.industry as string)
        out[k] ??= { won: 0, lost: 0 }
        if (r.status === 'won') out[k].won++
        else out[k].lost++
      }
      return out
    },
    async followUpSnapshot(org, opts): Promise<FollowUpSnapshot> {
      const now = Date.now()
      const { data: leads, error } = await db
        .from('leads')
        .select('id, company_name, status, contact_status, last_activity_at, created_at')
        .eq('organization_id', org)
        .is('deleted_at', null)
        .in('status', CONTACT_STAGES)
        .order('last_activity_at', { ascending: true, nullsFirst: true })
        .limit(opts.limit)
      if (error) fail('snapshot_leads', error)
      const ids = (leads ?? []).map((l) => l.id as string)
      const tasks: Row[] = []
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error: te } = await db.from('follow_up_tasks').select('id, lead_id, kind, is_contact, due_at, title').eq('organization_id', org).eq('status', 'open').in('lead_id', ids.slice(i, i + 200))
        if (te) fail('snapshot_tasks', te)
        tasks.push(...((data ?? []) as Row[]))
      }
      const { data: overdue, error: oe } = await db.from('follow_up_tasks').select('id, lead_id, title, due_at, kind').eq('organization_id', org).eq('status', 'open').lt('due_at', new Date(now).toISOString()).order('due_at').limit(100)
      if (oe) fail('snapshot_overdue', oe)
      const cutoff = new Date(now - opts.opportunityStaleDays * 86_400_000).toISOString()
      const { data: opps, error: pe } = await db
        .from('sales_opportunities')
        .select('id, lead_id, title, updated_at, lead:leads(contact_status, status, deleted_at)')
        .eq('organization_id', org)
        .eq('status', 'open')
        .lt('updated_at', cutoff)
        .limit(100)
      if (pe) fail('snapshot_opportunities', pe)
      const days = (iso: string | null) => (iso ? Math.floor((now - new Date(iso).getTime()) / 86_400_000) : null)
      return {
        leads: (leads ?? []).map((l) => ({
          id: l.id as string,
          company_name: l.company_name as string,
          status: l.status as string,
          contactable: l.contact_status === 'active' && l.status !== 'not_contactable',
          days_since_activity: days((l.last_activity_at as string | null) ?? (l.created_at as string)),
          open_tasks: tasks.filter((t) => t.lead_id === l.id).map((t) => ({ id: t.id as string, kind: t.kind as string, is_contact: !!t.is_contact, due_at: t.due_at as string, title: t.title as string })),
        })),
        overdue_tasks: (overdue ?? []) as FollowUpSnapshot['overdue_tasks'],
        stale_opportunities: (opps ?? [])
          .filter((o) => !(o.lead as unknown as { deleted_at: string | null } | null)?.deleted_at)
          .map((o) => {
            const lead = o.lead as unknown as { contact_status: string; status: string } | null
            return { id: o.id as string, lead_id: o.lead_id as string, title: o.title as string, days_since_update: days(o.updated_at as string) ?? 0, lead_contactable: lead?.contact_status === 'active' && lead?.status !== 'not_contactable' }
          }),
      }
    },
    async createFollowUpTasks(org, rows) {
      const created: string[] = []
      let skipped = 0
      for (const r of rows) {
        const { data: existing, error: ee } = await db.from('follow_up_tasks').select('id').eq('organization_id', org).eq('lead_id', r.leadId).eq('kind', r.kind).eq('status', 'open').limit(1)
        if (ee) fail('check_follow_up', ee)
        if (existing?.length) {
          skipped++
          continue
        }
        const { data, error } = await db
          .from('follow_up_tasks')
          .insert({ organization_id: org, lead_id: r.leadId, kind: r.kind, title: r.title, notes: r.notes, due_at: r.dueAt, opportunity_id: r.opportunityId, source: 'ai', created_by: r.createdBy })
          .select('id')
          .single()
        if (error) {
          // Lead diventato non contattabile nel frattempo: il trigger rifiuta il promemoria di contatto.
          if (error.message?.includes('lead_not_contactable')) {
            skipped++
            continue
          }
          fail('create_follow_up', error)
        }
        created.push(data.id as string)
      }
      return { created, skipped }
    },
    async blockFollowUpTasks(org, ids, reason) {
      if (!ids.length) return 0
      const { data, error } = await db.from('follow_up_tasks').update({ status: 'blocked', blocked_reason: reason }).eq('organization_id', org).eq('status', 'open').in('id', ids.slice(0, 200)).select('id')
      if (error) fail('block_follow_ups', error)
      return data?.length ?? 0
    },
    async growthMetrics(org, fromIso, toIso) {
      const { data, error } = await db.rpc('ai_growth_metrics', { p_org: org, p_from: fromIso, p_to: toIso })
      if (error) fail('growth_metrics', error)
      return data as GrowthMetrics
    },
    async updateLeadScore(org, leadId, s) {
      const { data, error } = await db
        .from('leads')
        .update({ score: s.score, priority: s.priority, score_basis: s.basis, score_breakdown: s.breakdown })
        .eq('organization_id', org)
        .eq('id', leadId)
        .is('deleted_at', null)
        .select('id')
      if (error) fail('update_lead_score', error)
      return !!data?.length
    },
  }
}
