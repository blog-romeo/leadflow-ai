/** Tipi lato client per il Lead Finder (allineati a netlify/functions/_shared/lead-finder). */
export type ProviderId = 'osm_overpass' | 'google_places' | 'csv_import'
export type Priority = 'high' | 'medium' | 'low'
export type CandidateStatus = 'new' | 'saved' | 'excluded'

export interface ProviderLicense {
  canStoreContent: boolean
  canExport: boolean
  canSaveToCrm: boolean
  attribution: string
  termsUrl: string
}
export interface ProviderInfo {
  id: Exclude<ProviderId, 'csv_import'>
  label: string
  configured: boolean
  missing: string[]
  license: ProviderLicense
  capabilities: { websiteFilterWith: boolean; websiteFilterWithout: boolean; keywordFiltering: boolean; maxResults: number }
}
export interface ProvidersResponse {
  providers: ProviderInfo[]
  ai: { configured: boolean; missing: string[] }
}

export interface CriterionScore {
  key: 'sector' | 'geography' | 'icp' | 'signals' | 'completeness'
  points: number
  max: number
  reason: string
  params?: Record<string, string | number>
  aiReason?: string
  evidence: string[]
}
export interface ScoreResult {
  score: number
  priority: Priority
  basis: 'rules' | 'ai'
  breakdown: CriterionScore[]
}

export interface NormalizedCompany {
  provider: ProviderId
  externalId: string
  companyName: string
  sector: string | null
  categoryTags: string[]
  address: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  website: string | null
  phone: string | null
  sourceUrl: string | null
  acquiredAt: string
}

type Basis = 'verified' | 'hypothesis' | 'missing'
export interface AnalysisResult {
  model: string
  analyzed_at: string
  website: { url: string | null; status: string; fetched_at: string | null }
  sector: { value: string; basis: Basis; evidence: string }
  activity_description: { value: string; basis: Basis; evidence: string }
  verified_facts: { statement: string; source: 'provider' | 'website'; evidence: string }[]
  hypotheses: { statement: string; rationale: string }[]
  digital_needs: { need: string; rationale: string; evidence: string }[]
  opportunities: { opportunity: string; rationale: string }[]
  missing_information: string[]
  fit: { sector_rating: number; sector_reason: string; icp_rating: number; icp_reason: string }
  signals: { signal: string; evidence: string; verified: boolean }[]
  qualification_reason: string
}

export interface CandidateRow {
  id: string
  provider: ProviderId
  external_id: string
  search_id: string | null
  status: CandidateStatus
  lead_id: string | null
  can_store_content: boolean
  can_export: boolean
  can_save_to_crm: boolean
  company_name: string | null
  sector: string | null
  address: string | null
  city: string | null
  region: string | null
  country: string | null
  website: string | null
  phone: string | null
  source_url: string | null
  attribution: string | null
  score: number | null
  priority: Priority | null
  score_basis: 'rules' | 'ai' | null
  score_breakdown: CriterionScore[] | null
  analysis: AnalysisResult | null
  last_analyzed_at: string | null
  acquired_at: string
  last_seen_at: string
}

export interface SearchResponse {
  search_id: string
  provider: ProviderId
  counts: { found: number; new: number; already_known: number; duplicates_in_batch: number; excluded: number; in_crm: number }
  usage: { searches: { used: number; limit: number }; results: { used: number; limit: number } }
  license: ProviderLicense
  ephemeral?: { candidate_id: string; company: NormalizedCompany; score: ScoreResult; in_crm: boolean; excluded: boolean }[]
}

export interface UsageSummary {
  plan: string
  searches: { used: number; limit: number }
  results: { used: number; limit: number }
  ai_analyses: { used: number; limit: number }
}

/** Dati mostrati per una riga: dal database o, per le fonti senza memorizzazione, dalla sessione. */
export interface CandidateView extends CandidateRow {
  sessionOnly: boolean
  sessionScore: ScoreResult | null
}
