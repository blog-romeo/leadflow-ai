import { sanitizeDeep, type SanitizeStats } from './sanitize'

/**
 * Costruzione del contesto per il modello con minimizzazione dei dati:
 * nessuna email, telefono, nominativo o nota libera del lead viene inviata.
 * Tutti i testi di provenienza esterna sono sanificati.
 */
export interface SalesService {
  id: string
  name: string
  description?: string | null
  price_from?: number | null
  price_to?: number | null
  price_unit?: string | null
}

export interface SalesProfile {
  organizationId: string
  commercialName: string | null
  sector: string | null
  offerDescription: string | null
  services: SalesService[]
  priceRange: string | null
  currency: string
  servedAreas: string[]
  idealCustomer: string | null
  differentiators: string[]
  website: string | null
  language: 'it' | 'en'
  tone: 'formal' | 'friendly' | 'direct' | 'consultative'
  callToAction: string | null
  bookingUrl: string | null
  commercialTerms: string | null
  followUpDays: number[]
}

export interface LeadRaw {
  lead: {
    id: string
    company_name: string
    website: string | null
    phone: string | null
    industry: string | null
    city: string | null
    region: string | null
    country: string | null
    status: string
    contact_status: 'active' | 'opted_out' | 'suppressed'
    score: number | null
    priority: string | null
    score_breakdown: unknown
    last_activity_at: string | null
    created_at: string
    deleted_at: string | null
  }
  source: { name: string; type: string; legal_basis: string; provider: string | null } | null
  businessAnalysis: Record<string, unknown> | null
  intelligence: Record<string, unknown> | null
  activities: { type: string; subject: string | null; occurred_at: string }[]
  opportunity: { title: string; service_name: string | null; value_amount: number | null; currency: string; status: string } | null
  proposals: { title: string; status: string; created_at: string }[]
  openTasks: { kind: string; title: string; due_at: string; status: string }[]
}

export const REQUIRED_PROFILE_FIELDS = ['commercialName', 'offerDescription', 'services', 'callToAction'] as const

export function profileMissing(p: SalesProfile): string[] {
  const missing: string[] = []
  if (!p.commercialName) missing.push('commercialName')
  if (!p.offerDescription) missing.push('offerDescription')
  if (p.services.length === 0) missing.push('services')
  if (!p.callToAction) missing.push('callToAction')
  return missing
}

export function isContactable(raw: LeadRaw): boolean {
  return raw.lead.contact_status === 'active' && raw.lead.status !== 'not_contactable' && !raw.lead.deleted_at
}

/** Profilo: dati inseriti dall'organizzazione (attendibili ma comunque solo "dati"). */
export function profileForModel(p: SalesProfile) {
  return {
    commercial_name: p.commercialName,
    sector: p.sector,
    offer: p.offerDescription,
    services: p.services.map((s) => ({ id: s.id, name: s.name, description: s.description ?? null, price_from: s.price_from ?? null, price_to: s.price_to ?? null, price_unit: s.price_unit ?? null })),
    price_range: p.priceRange,
    currency: p.currency,
    served_areas: p.servedAreas,
    ideal_customer: p.idealCustomer,
    differentiators: p.differentiators,
    website: p.website,
    call_to_action: p.callToAction,
    booking_url: p.bookingUrl,
  }
}

function pickAnalysis(a: Record<string, unknown> | null) {
  if (!a) return null
  const keys = ['sector', 'activity_description', 'verified_facts', 'hypotheses', 'digital_needs', 'opportunities', 'missing_information', 'signals', 'qualification_reason', 'analyzed_at']
  return Object.fromEntries(keys.filter((k) => k in a).map((k) => [k, a[k]]))
}

/** Lead: solo dati aziendali e commerciali necessari, sanificati. */
export function leadForModel(raw: LeadRaw, stats: SanitizeStats) {
  const l = raw.lead
  const daysSince = l.last_activity_at ? Math.floor((Date.now() - new Date(l.last_activity_at).getTime()) / 86_400_000) : null
  return sanitizeDeep(
    {
      id: l.id,
      company_name: l.company_name,
      industry: l.industry,
      location: [l.city, l.region, l.country].filter(Boolean).join(', ') || null,
      website: l.website,
      pipeline_stage: l.status,
      contactable: isContactable(raw),
      score: l.score,
      priority: l.priority,
      score_breakdown: l.score_breakdown,
      days_since_last_activity: daysSince,
      source: raw.source ? { name: raw.source.name, type: raw.source.type, legal_basis: raw.source.legal_basis } : null,
      business_analysis: pickAnalysis(raw.businessAnalysis),
      previous_intelligence: raw.intelligence
        ? { fit_summary: raw.intelligence.fit_summary, operational_priority: raw.intelligence.operational_priority, analyzed_at: raw.intelligence.analyzed_at }
        : null,
      recent_activities: raw.activities.slice(0, 10),
      open_opportunity: raw.opportunity,
      proposals: raw.proposals.slice(0, 5),
      open_follow_ups: raw.openTasks.slice(0, 5),
    },
    1500,
    stats,
  )
}

/** Valori ammessi nei testi generati (URL, telefoni, importi del listino). */
export function allowedValues(p: SalesProfile, raw: LeadRaw | null) {
  const amounts: number[] = []
  for (const s of p.services) {
    if (typeof s.price_from === 'number') amounts.push(s.price_from)
    if (typeof s.price_to === 'number') amounts.push(s.price_to)
  }
  if (raw?.opportunity?.value_amount != null) amounts.push(Number(raw.opportunity.value_amount))
  return {
    urls: [p.website, p.bookingUrl, raw?.lead.website].filter((u): u is string => !!u),
    phones: [raw?.lead.phone].filter((u): u is string => !!u),
    amounts,
  }
}
