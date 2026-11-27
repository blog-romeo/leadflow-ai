/** Tipi condivisi del modulo Demand Hunter (integrazione di BuyerML «La caccia»). */
export type Goal = 'clienti' | 'lavoro'
export const GOALS: Goal[] = ['clienti', 'lavoro']
export type DhMode = 'simulated' | 'live'
export type DhAction = 'hunt' | 'expand'
export type JobStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted'
export const TERMINAL_JOB_STATUSES: JobStatus[] = ['completed', 'stopped', 'failed', 'interrupted']
export type Verdict = 'giusto' | 'sbagliato'

/** Utente tecnico della sincronizzazione programmata (nessun utente reale: non viene mai registrato come autore). */
export const SYSTEM_USER = '00000000-0000-4000-8000-000000000000'

export interface Ctx {
  orgId: string
  userId: string
}

/** Stato del servizio Python → stato del job nel database. */
export const SERVICE_STATUS: Record<string, JobStatus> = {
  'in coda': 'queued',
  'in corso': 'running',
  finita: 'completed',
  fermata: 'stopped',
  errore: 'failed',
  interrotta: 'interrupted',
}

/** Prova testuale della classificazione (demand.py: segnale + parola trovata nel testo). */
export interface Evidence {
  signal: string | null
  match: string | null
}

/** Lettura di un post (contratto di demand.Reading, campi usati dal gateway). */
export interface Reading {
  author_role: string
  demand: string
  intent_types: string[]
  stage: string
  lead_score: number
  confidence: number
  urgency: string
  budget_declared: boolean
  specificity: string
  lead_class: string
  taxonomy_path: string[]
  technology: string[]
  evidence: Evidence[]
  reader: string
}

export interface ServiceLead {
  url: string
  text: string
  demand: string
  stage: string
  score: number
  intents: string[]
  node: string | null
  technology: string[]
  lead_class: string
  query: string
  verb: string
  object: string
  found_at: string
  reading?: Reading
  verdict?: Verdict | null
}

export interface ServiceCombo {
  query: string
  verb: string
  object: string
  origin: string
  status: 'da provare' | 'provata' | 'già fatta' | 'abbandonata'
  results: number
  leads: number
  priority: number
}

export interface ServiceSnapshot {
  seed: string
  goal: Goal
  status: string
  budget: number
  spent: { searches: number; autocomplete: number }
  combos: number
  by_status: Record<string, number>
  leads: number
  combos_list: ServiceCombo[]
  verbs: { text: string; searches: number; results: number; leads: number; dropped: boolean; weight: number }[]
  objects: { text: string; searches: number; results: number; leads: number; dropped: boolean; weight: number }[]
  lead_list: ServiceLead[]
  events: { at: string; kind: string; text: string }[]
  mode: DhMode
}

export interface ServiceJobView {
  job_id: string
  status: string
  error: string | null
  terminal: boolean
  hunt: ServiceSnapshot | null
  mode: DhMode
}
