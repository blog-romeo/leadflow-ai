/**
 * SOLO TEST: AgentStore in memoria che replica i vincoli del database della migrazione 0012
 * (lease con token, idempotenza per organizzazione, stati finali immutabili, vincolo FACT/UNKNOWN/INFERENCE,
 * isolamento per organizzazione, registri append-only). NON è un'integrazione reale.
 */
import { randomUUID } from 'node:crypto'
import { HttpError } from '../../http'
import type { AgentStore, FollowUpSnapshot, GrowthMetrics, MemoryEntry, WorkflowCreate } from '../store'
import type { ToolCallRecord } from '../tools'
import type { AgentConfig, ApprovalRecord, CostWrite, EvidenceWrite, StepRecord, WorkflowRecord } from '../types'

export interface AgentMemState {
  workflows: (WorkflowRecord & { idempotencyKey: string; lockToken: string | null; lockedUntil: number | null; completedAt?: string })[]
  steps: (StepRecord & { startedAt?: string; completedAt?: string | null })[]
  runs: { id: string; org: string; workflowId: string | null; stepId: string | null; agentKey: string; attempt: number; status: string; errorCode?: string | null; creditsUsed?: number; output?: unknown }[]
  toolCalls: (ToolCallRecord & { org: string })[]
  approvals: (ApprovalRecord & { org: string })[]
  evidence: (EvidenceWrite & { org: string })[]
  costs: (CostWrite & { org: string; at: string })[]
  memory: (MemoryEntry & { org: string; status: 'active' | 'superseded'; expiresAt: number })[]
  audit: { org: string; actor: string | null; action: string; metadata?: Record<string, unknown> }[]
  configs: (AgentConfig & { org: string })[]
  creditCosts: Record<string, number>
  aiJobs: { id: string; org: string; task: string; leadId: string | null; status: string; output?: unknown; error?: string | null; tokens?: number; createdAt: number }[]
  /** Crediti del piano simulati: null = illimitati. Un job oltre il limite è rifiutato come dal trigger di billing. */
  planCredits: number | null
  planCreditsUsed: number
  searchCandidates: Record<string, string[]>
  history: Record<string, Record<string, { won: number; lost: number }>>
  followUp: Record<string, FollowUpSnapshot>
  followUpTasks: { id: string; org: string; leadId: string; kind: string; status: string; title: string; blockedReason?: string; source: string }[]
  notContactableLeads: Set<string>
  metrics: Record<string, GrowthMetrics>
  leadScores: Record<string, { org: string; score: number }>
  /** Replica del trigger ai_workflows_concurrency_guard (migrazione 0013); undefined = nessun limite. */
  maxActiveWorkflows?: number
}

export function emptyMetrics(over: Partial<GrowthMetrics> = {}): GrowthMetrics {
  return {
    leads_acquired: 0, leads_qualified: 0, leads_contactable: 0, leads_contacted: 0, responses: 0, appointments: 0, opportunities: 0, customers_won: 0,
    revenue_attributed: {}, won_without_value: 0, ai_cost_usd: 0, ai_cost_unpriced_jobs: 0, provider_cost_usd: 0, provider_cost_unpriced_calls: 0,
    cost_per_lead_usd: null, by_sector: [], ...over,
  }
}

const FINAL = ['completed', 'partial', 'failed', 'cancelled']

export function createMemoryAgentStore(init: Partial<AgentMemState> = {}) {
  const s: AgentMemState = {
    workflows: [], steps: [], runs: [], toolCalls: [], approvals: [], evidence: [], costs: [], memory: [], audit: [], configs: [],
    creditCosts: { business_analysis: 1, sales_strategy: 2, follow_up_suggestion: 1, messages: 1, proposal: 3 },
    aiJobs: [], planCredits: null, planCreditsUsed: 0, searchCandidates: {}, history: {}, followUp: {}, followUpTasks: [],
    notContactableLeads: new Set(), metrics: {}, leadScores: {},
    ...init,
  }
  const wfOf = (id: string) => s.workflows.find((w) => w.id === id)
  const clone = <T>(v: T): T => structuredClone(v)
  const toRecord = (w: AgentMemState['workflows'][number]): WorkflowRecord => {
    const { idempotencyKey: _k, lockToken: _t, lockedUntil: _l, completedAt: _c, ...rest } = w
    return clone(rest)
  }
  const setStatus = (w: AgentMemState['workflows'][number], status: WorkflowRecord['status']) => {
    // Stati finali immutabili, come il trigger ai_workflows_guard.
    if (FINAL.includes(w.status) && w.status !== status) throw new Error('workflow_finalized')
    w.status = status
  }

  const store: AgentStore = {
    async getAgentConfigs(org) {
      return s.configs.filter((c) => c.org === org).map(({ org: _o, ...c }) => clone(c))
    },
    async getCreditCosts() {
      return { ...s.creditCosts }
    },
    async getMonthlySpend(org, fromIso) {
      const rows = s.costs.filter((c) => c.org === org && c.at >= fromIso)
      const byAgent: Record<string, number> = {}
      for (const r of rows) byAgent[r.agentKey] = (byAgent[r.agentKey] ?? 0) + r.credits
      return { credits: rows.reduce((a, r) => a + r.credits, 0), byAgent }
    },
    async createWorkflow(row: WorkflowCreate) {
      const existing = s.workflows.find((w) => w.organizationId === row.org && w.idempotencyKey === row.idempotencyKey)
      if (existing) return { workflow: toRecord(existing), created: false }
      if (s.maxActiveWorkflows !== undefined && s.workflows.filter((w) => w.organizationId === row.org && (w.status === 'pending' || w.status === 'running')).length >= s.maxActiveWorkflows) {
        throw new HttpError(409, 'too_many_active_workflows', { limit: s.maxActiveWorkflows })
      }
      const id = randomUUID()
      s.workflows.push({
        id, organizationId: row.org, template: row.template, objective: row.objective, params: clone(row.params), status: 'pending',
        budgetCredits: row.budgetCredits, creditsUsed: 0, costUsd: 0, maxRuntimeSeconds: row.maxRuntimeSeconds, deadlineAt: null,
        cancelRequestedAt: null, createdBy: row.createdBy, resumeCount: 0, startedAt: null, errorCode: null, report: null,
        createdAt: new Date().toISOString(), idempotencyKey: row.idempotencyKey, lockToken: null, lockedUntil: null,
      })
      for (const st of row.steps) {
        s.steps.push({ id: randomUUID(), workflowId: id, organizationId: row.org, position: st.position, agentKey: st.agentKey, action: st.action, dependsOn: st.dependsOn, requiresApproval: st.requiresApproval, status: 'pending', attempts: 0, maxAttempts: st.maxAttempts, timeoutSeconds: st.timeoutSeconds, input: clone(st.input), output: null, errorCode: null })
      }
      return { workflow: toRecord(wfOf(id)!), created: true }
    },
    async getWorkflow(id) {
      const w = wfOf(id)
      return w ? toRecord(w) : null
    },
    async getSteps(org, workflowId) {
      return s.steps.filter((x) => x.organizationId === org && x.workflowId === workflowId).sort((a, b) => a.position - b.position).map((x) => clone(x))
    },
    async claimWorkflow(id, token, leaseSeconds) {
      const w = wfOf(id)
      if (!w || !['pending', 'running'].includes(w.status)) return null
      if (w.lockedUntil !== null && w.lockedUntil > Date.now()) return null
      w.lockToken = token
      w.lockedUntil = Date.now() + leaseSeconds * 1000
      w.status = 'running'
      return toRecord(w)
    },
    async renewLease(org, id, token, leaseSeconds) {
      const w = wfOf(id)
      if (!w || w.organizationId !== org || w.lockToken !== token) return false
      w.lockedUntil = Date.now() + leaseSeconds * 1000
      return true
    },
    async updateWorkflow(org, id, token, p) {
      const w = wfOf(id)
      if (!w || w.organizationId !== org || w.lockToken !== token) return false
      if (p.status) setStatus(w, p.status)
      if (p.creditsUsed !== undefined) w.creditsUsed = p.creditsUsed
      if (p.costUsd !== undefined) w.costUsd = p.costUsd
      if (p.errorCode !== undefined) w.errorCode = p.errorCode
      if (p.report !== undefined) w.report = p.report
      if (p.startedAt) w.startedAt = p.startedAt
      if (p.deadlineAt) w.deadlineAt = p.deadlineAt
      if (p.resumeCount !== undefined) w.resumeCount = p.resumeCount
      return true
    },
    async releaseWorkflow(org, id, token, p) {
      const w = wfOf(id)
      if (!w || w.organizationId !== org || w.lockToken !== token) return
      if (p.status) setStatus(w, p.status)
      if (p.creditsUsed !== undefined) w.creditsUsed = p.creditsUsed
      if (p.costUsd !== undefined) w.costUsd = p.costUsd
      if (p.errorCode !== undefined) w.errorCode = p.errorCode
      if (p.report !== undefined) w.report = p.report
      if (p.completedAt) w.completedAt = p.completedAt
      if (p.resumeCount !== undefined) w.resumeCount = p.resumeCount
      w.lockToken = null
      w.lockedUntil = null
    },
    async heartbeat(org, id, token, leaseSeconds, usage) {
      const w = wfOf(id)
      if (!w || w.organizationId !== org || w.lockToken !== token) return { renewed: false, cancelRequested: false }
      w.lockedUntil = Date.now() + leaseSeconds * 1000
      w.creditsUsed = usage.creditsUsed
      w.costUsd = usage.costUsd
      return { renewed: true, cancelRequested: !!w.cancelRequestedAt || w.status === 'cancelled' }
    },
    async isCancelRequested(org, id) {
      const w = wfOf(id)
      return !!w && w.organizationId === org && (!!w.cancelRequestedAt || w.status === 'cancelled')
    },
    async updateStep(org, stepId, p) {
      const st = s.steps.find((x) => x.id === stepId && x.organizationId === org)
      if (!st) return
      if (p.status) st.status = p.status
      if (p.attempts !== undefined) st.attempts = p.attempts
      if (p.output !== undefined) st.output = clone(p.output)
      if (p.errorCode !== undefined) st.errorCode = p.errorCode
      if (p.completedAt !== undefined) st.completedAt = p.completedAt
    },
    async createRun(row) {
      const ex = s.runs.find((r) => r.stepId && r.stepId === row.stepId && r.attempt === row.attempt)
      if (ex) return ex.id
      const id = randomUUID()
      s.runs.push({ id, org: row.org, workflowId: row.workflowId, stepId: row.stepId, agentKey: row.agentKey, attempt: row.attempt, status: 'running' })
      return id
    },
    async finishRun(org, runId, p) {
      const r = s.runs.find((x) => x.id === runId && x.org === org)
      if (!r) return
      Object.assign(r, { status: p.status, errorCode: p.errorCode ?? null, creditsUsed: p.creditsUsed, output: p.output })
    },
    async recordToolCall(org, r) {
      s.toolCalls.push({ ...clone(r), org })
    },
    async createApproval(row) {
      const id = randomUUID()
      s.approvals.push({ id, org: row.org, organizationId: row.org, workflowId: row.workflowId, stepId: row.stepId, action: row.action, status: 'pending', decidedBy: null, expiresAt: new Date(Date.now() + row.expiresHours * 3_600_000).toISOString(), summary: clone(row.summary) })
      return id
    },
    async getApproval(org, id) {
      const a = s.approvals.find((x) => x.id === id && x.org === org)
      if (!a) return null
      const { org: _o, ...rest } = a
      return clone(rest)
    },
    async expireApprovals() {
      const out: string[] = []
      for (const a of s.approvals.filter((x) => x.status === 'pending' && new Date(x.expiresAt).getTime() < Date.now())) {
        a.status = 'expired'
        const st = s.steps.find((x) => x.id === a.stepId)
        if (st?.status === 'waiting_approval') Object.assign(st, { status: 'skipped', errorCode: 'approval_expired' })
        const w = wfOf(a.workflowId)
        if (w?.status === 'waiting_approval') Object.assign(w, { status: 'pending', lockToken: null, lockedUntil: null })
        out.push(a.workflowId)
      }
      return out
    },
    async listResumable(limit) {
      return s.workflows.filter((w) => w.status === 'pending' || (w.status === 'running' && (w.lockedUntil ?? 0) < Date.now())).slice(0, limit).map((w) => w.id)
    },
    async insertEvidence(org, rows) {
      for (const e of rows) {
        // Vincoli CHECK della tabella ai_research_evidence.
        if (e.kind === 'fact' && (!['provider', 'website', 'crm'].includes(e.sourceType) || !(e.evidence ?? '').trim())) throw new Error('23514 fact_requires_source')
        if (e.kind === 'unknown' && e.sourceType !== 'none') throw new Error('23514 unknown_without_source')
        if (e.kind === 'inference' && e.sourceType !== 'ai') throw new Error('23514 inference_is_ai')
        s.evidence.push({ ...clone(e), org })
      }
      return rows.length
    },
    async listEvidence(org, subjectType, subjectId, limit) {
      return s.evidence.filter((e) => e.org === org && e.subjectType === subjectType && e.subjectId === subjectId).slice(0, limit).map(({ org: _o, ...e }) => clone(e))
    },
    async recordCost(org, row) {
      s.costs.push({ ...clone(row), org, at: new Date().toISOString() })
    },
    async getMemory(org, categories, limit) {
      return s.memory
        .filter((m) => m.org === org && m.status === 'active' && m.expiresAt > Date.now() && categories.includes(m.category))
        .slice(0, limit)
        .map(({ org: _o, status: _s, expiresAt: _e, ...m }) => clone(m))
    },
    async audit(org, actor, action, _t, _id, metadata) {
      s.audit.push({ org, actor, action, metadata })
    },
    async createAiJob(row) {
      const cost = s.creditCosts[row.task] ?? 0
      if (s.planCredits !== null && s.planCreditsUsed + cost > s.planCredits) {
        // Come il trigger ai_jobs_billing_reserve → HttpError 402 dal billingDbError.
        throw Object.assign(new Error('billing_insufficient_credits'), { status: 402, code: 'billing_insufficient_credits' })
      }
      s.planCreditsUsed += cost
      const id = randomUUID()
      s.aiJobs.push({ id, org: row.org, task: row.task, leadId: row.leadId, status: 'running', createdAt: Date.now() })
      return id
    },
    async finishAiJob(org, id, p) {
      const j = s.aiJobs.find((x) => x.id === id && x.org === org)
      if (!j) return
      j.status = p.status
      j.output = p.output
      j.error = p.error ?? null
      // Crediti rimborsati sui job falliti, come billing_release_credits.
      if (p.status === 'failed') s.planCreditsUsed -= s.creditCosts[j.task] ?? 0
    },
    async findRecentStrategy(org, leadId, inputHash, sinceIso) {
      const since = new Date(sinceIso).getTime()
      const j = s.aiJobs.filter((x) => x.org === org && x.task === 'sales_strategy' && x.leadId === leadId && x.status === 'succeeded' && x.createdAt >= since && (x.output as { input_hash?: string } | undefined)?.input_hash === inputHash).pop()
      return j ? clone((j.output as { strategy: Record<string, unknown> }).strategy) : null
    },
    async listCandidatesBySearch(org, searchId) {
      return [...(s.searchCandidates[`${org}:${searchId}`] ?? [])]
    },
    async sectorHistory(org) {
      return clone(s.history[org] ?? {})
    },
    async followUpSnapshot(org) {
      return clone(s.followUp[org] ?? { leads: [], overdue_tasks: [], stale_opportunities: [] })
    },
    async createFollowUpTasks(org, rows) {
      const created: string[] = []
      let skipped = 0
      for (const r of rows) {
        if (s.followUpTasks.some((t) => t.org === org && t.leadId === r.leadId && t.kind === r.kind && t.status === 'open')) {
          skipped++
          continue
        }
        // Trigger follow_ups_guard: nessun promemoria di contatto per lead non contattabili.
        if (r.kind !== 'opportunity_review' && s.notContactableLeads.has(r.leadId)) {
          skipped++
          continue
        }
        const id = randomUUID()
        s.followUpTasks.push({ id, org, leadId: r.leadId, kind: r.kind, status: 'open', title: r.title, source: 'ai' })
        created.push(id)
      }
      return { created, skipped }
    },
    async blockFollowUpTasks(org, ids, reason) {
      let n = 0
      for (const t of s.followUpTasks) {
        if (t.org === org && ids.includes(t.id) && t.status === 'open') {
          t.status = 'blocked'
          t.blockedReason = reason
          n++
        }
      }
      return n
    },
    async growthMetrics(org, fromIso) {
      return clone(s.metrics[`${org}:${fromIso.slice(0, 10)}`] ?? s.metrics[org] ?? emptyMetrics())
    },
    async updateLeadScore(org, leadId, sc) {
      s.leadScores[leadId] = { org, score: sc.score }
      return true
    },
  }

  /** Simula le RPC del database (ai_agent_decide_approval, ai_workflow_request_cancel) per i test. */
  const rpc = {
    decide(approvalId: string, org: string, decision: 'approve' | 'reject', actor = 'admin') {
      const a = s.approvals.find((x) => x.id === approvalId && x.org === org)
      if (!a) throw new Error('approval_not_found')
      if (a.status !== 'pending') throw new Error('approval_not_pending')
      const w = wfOf(a.workflowId)!
      if (w.status !== 'waiting_approval') throw new Error('workflow_not_waiting')
      a.status = decision === 'approve' ? 'approved' : 'rejected'
      a.decidedBy = actor
      const st = s.steps.find((x) => x.id === a.stepId)!
      if (decision === 'approve') Object.assign(st, { status: 'pending', input: { ...st.input, approval_id: a.id } })
      else Object.assign(st, { status: 'skipped', errorCode: 'approval_rejected' })
      Object.assign(w, { status: 'pending', lockToken: null, lockedUntil: null })
    },
    cancel(workflowId: string) {
      const w = wfOf(workflowId)!
      if (FINAL.includes(w.status)) return
      if (w.status === 'pending' || w.status === 'waiting_approval') {
        for (const a of s.approvals.filter((x) => x.workflowId === w.id && x.status === 'pending')) a.status = 'cancelled'
        for (const st of s.steps.filter((x) => x.workflowId === w.id && ['pending', 'waiting_approval'].includes(x.status))) st.status = 'cancelled'
        Object.assign(w, { status: 'cancelled', cancelRequestedAt: new Date().toISOString(), errorCode: 'cancelled_by_user', lockToken: null, lockedUntil: null })
      } else {
        w.cancelRequestedAt = new Date().toISOString()
      }
    },
  }
  return { store, state: s, rpc }
}
