/** Tipi delle API /api/demand-hunter/* (vedi netlify/functions/_shared/demand-hunter/services.ts). */
export type Goal = 'clienti' | 'lavoro'
export type DhMode = 'simulated' | 'live'
export type JobStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted'
export const TERMINAL: JobStatus[] = ['completed', 'stopped', 'failed', 'interrupted']
export type Verdict = 'giusto' | 'sbagliato'

export interface Usage {
  enabled: boolean
  monthly_paid_calls: number
  max_budget_per_hunt: number
  used: number
  remaining: number
}

export interface SessionSummary {
  id: string
  job_id: string
  goal: Goal
  seed: string
  budget: number
  status: JobStatus
  mode: DhMode
  leads_found: number
  created_at: string
}

export interface StatusResponse {
  configured: boolean
  config_missing: string[]
  service: { reachable: boolean; mode?: DhMode; search_provider_configured?: boolean; max_budget_per_hunt?: number; running?: number }
  service_error: string | null
  usage: Usage
  sessions: SessionSummary[]
}

export interface AreaNode {
  label: string
  rel: string
  source: string
  children: AreaNode[]
  hunted: number
  leads: number
}

export interface AreasResponse {
  tree: AreaNode
  mode: DhMode
  suggestions: { seed: string; reason: string; source: string }[]
}

export interface EstimateResponse {
  action: 'hunt' | 'expand'
  goal: Goal
  subject: string
  paid_calls: number
  mode: DhMode
  usage: Usage
  plan: { combos?: number; already_done?: number; objects?: string[]; verbs?: string[]; phrases?: string[]; cost?: string }
  allowed: boolean
  reason?: string
  confirm_token?: string
  expires_at?: string
}

export interface Evidence {
  signal: string | null
  match: string | null
}

export interface LeadView {
  id: string
  url: string
  text: string
  score: number
  stage: string | null
  lead_class: string | null
  technology: string[]
  query: string | null
  verb: string | null
  object: string | null
  status: 'new' | 'transferred' | 'dismissed'
  crm_lead_id: string | null
  simulated: boolean
  verdict: Verdict | null
  reading: { author_role: string; intent_types: string[]; stage: string; confidence: number; urgency: string; budget_declared: boolean; evidence: Evidence[] } | null
  priority: 'high' | 'medium' | 'low'
  qualified: boolean
  reasons: string[]
}

export interface ComboView {
  query: string
  verb: string
  object: string
  origin: string
  status: 'da provare' | 'provata' | 'già fatta' | 'abbandonata'
  results: number
  leads: number
  priority: number
}

export interface JobViewResponse {
  service_reachable: boolean
  job: { id: string; kind: 'hunt' | 'expand'; status: JobStatus; mode: DhMode; reserved_calls: number; spent: { searches: number; autocomplete: number }; progress: Record<string, unknown>; error_code: string | null; created_at: string }
  session: { id: string; goal: Goal; seed: string; budget: number; status: JobStatus; combos_total: number; leads_found: number; events: { at: string; kind: string; text: string }[]; verbs: { text: string; searches: number; leads: number; dropped: boolean }[]; objects: { text: string; searches: number; leads: number; dropped: boolean }[] } | null
  combos: ComboView[]
  leads: LeadView[]
}

export interface LearningStat {
  key: string
  searches: number
  posts: number
  leads: number
  confirmed: number
  wrong: number
  rate: number
  score: number
}

export interface LearningResponse {
  source: 'service' | 'cache'
  totals: { hunts?: number; searches?: number; posts?: number; leads?: number; feedback?: Record<string, number> } | null
  verbs: LearningStat[]
  objects: LearningStat[]
  patterns: LearningStat[]
}

export interface CrmResponse {
  results: { lead_id: string; outcome: string; crm_lead_id?: string }[]
  saved: number
}
