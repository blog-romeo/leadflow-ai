import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiFetch } from '../../lib/api'
import { Badge } from '../../components/ui/Badge'
import type { AiAgentKey, AiStepStatus, AiWorkflowStatus } from '../../lib/database.types'

/** Tipi delle risposte delle API del motore multi-agent (vedi netlify/functions/ai-*). */
export interface PlanIssue {
  code: string
  component: string
  env?: string[]
  feature?: string
  fields?: string[]
}
export interface PlanStep {
  position: number
  agentKey: AiAgentKey
  action: string
  dependsOn: number[]
  requiresApproval: boolean
}
export interface Plan {
  template: 'prospecting' | 'follow_up_review' | 'growth_report'
  params: Record<string, unknown>
  steps: PlanStep[]
  approvals: string[]
  estimate: { max_credits: number; by_agent: Record<string, number> }
  missing: PlanIssue[]
  warnings: string[]
  blocked: boolean
}
export interface PlanResponse {
  interpretation: { template: Plan['template']; params: Record<string, unknown>; recognized: string[]; warnings: string[] } | null
  plan: Plan | null
  invalid_fields?: string[]
}
export interface AgentsStatus {
  enabled: boolean
  pilot?: boolean
  is_admin?: boolean
  catalog?: { key: AiAgentKey; tools: string[]; features: string[]; default_tier: string; uses_ai: boolean }[]
  availability?: {
    providers: { id: string; configured: boolean; canStore: boolean; missing: string[] }[]
    ai: { configured: boolean; missing: string[] }
    features: Record<string, boolean>
    salesProfileMissing: string[]
    creditCosts: Record<string, number>
    models: Record<string, { model_configured: boolean; fallback: boolean }>
  }
  spend_month?: { credits: number; byAgent: Record<string, number> }
  /** Prompt 10: ultimo esito reale delle verifiche di connessione. */
  connections?: { key: string; status: 'verified' | 'failed' | 'not_configured'; code: string; latency_ms: number | null; checked_at: string }[]
}

export const TERMINAL: AiWorkflowStatus[] = ['completed', 'partial', 'failed', 'cancelled']
export const actionKey = (action: string) => action.replace(/\./g, '_')

export function workflowTone(s: AiWorkflowStatus | AiStepStatus | string): 'ok' | 'danger' | 'signal' | 'flow' | 'neutral' {
  if (s === 'completed' || s === 'succeeded') return 'ok'
  if (s === 'failed' || s === 'timed_out') return 'danger'
  if (s === 'waiting_approval' || s === 'partial') return 'signal'
  if (s === 'running') return 'flow'
  return 'neutral'
}

export function StatusBadge({ label, status }: { label: string; status: string }) {
  return <Badge tone={workflowTone(status)}>{label}</Badge>
}

type T = (k: string, v?: Record<string, string | number>) => string

/** Messaggio leggibile per un codice di errore delle API o del motore (mai dettagli interni). */
export function codeMessage(code: string | null | undefined, t: T): string {
  if (!code) return ''
  const key = `aiWorkflows.codes.${code}`
  const msg = t(key)
  return msg === key ? `${t('aiWorkflows.codes.generic')} (${code})` : msg
}

export function aiErrorMessage(err: unknown, t: T): string {
  if (err instanceof ApiError) return codeMessage(err.code, t)
  const m = (err as { message?: string })?.message
  return m && /^[a-z_]{3,60}$/.test(m) ? codeMessage(m, t) : t('aiWorkflows.codes.generic')
}

export function newIdempotencyKey(): string {
  const raw = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `wf-${raw}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
}

/** Stato del motore per l'organizzazione corrente. */
export function useAgentsStatus(orgId: string | undefined) {
  const [status, setStatus] = useState<AgentsStatus | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = useCallback(async () => {
    if (!orgId) return
    try {
      setError(null)
      setStatus(await apiFetch<AgentsStatus>(`/api/ai-agents/status?organization_id=${orgId}`))
    } catch (e) {
      setError(e)
    }
  }, [orgId])
  useEffect(() => {
    void load()
  }, [load])
  return { status, error, reload: load }
}

/** Esegue `fn` ogni `ms` finché `active` è vero (pagina visibile). */
export function usePolling(fn: () => void, ms: number, active: boolean) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') ref.current()
    }, ms)
    return () => clearInterval(id)
  }, [ms, active])
}

export async function controlWorkflow(orgId: string, workflowId: string, action: 'cancel' | 'approve' | 'reject', approvalId?: string) {
  return apiFetch<Record<string, unknown>>('/api/ai-workflows/control', { method: 'POST', body: { organization_id: orgId, workflow_id: workflowId, action, ...(approvalId ? { approval_id: approvalId } : {}) } })
}
