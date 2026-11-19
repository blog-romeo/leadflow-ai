import { fold, tokens } from './normalize'
import { matchSector } from './sectors'
import type { IcpProfile, Priority } from './types'
import type { AnalysisResult } from './analysis/schema'

/**
 * Lead scoring 0–100 su cinque criteri con pesi configurabili per organizzazione.
 * I criteri verificabili (settore, area, completezza) sono calcolati con regole
 * deterministiche; coerenza con il cliente ideale e segnali commerciali richiedono
 * un'analisi AI e contano solo segnali con evidenza verificata nel testo sorgente.
 */
export type CriterionKey = 'sector' | 'geography' | 'icp' | 'signals' | 'completeness'

export interface CriterionScore {
  key: CriterionKey
  points: number
  max: number
  /** Codice motivazione (tradotto nell'interfaccia) + parametri. */
  reason: string
  params?: Record<string, string | number>
  /** Testo libero proveniente dall'analisi AI, se presente. */
  aiReason?: string
  evidence: string[]
}

export interface ScoreResult {
  score: number
  priority: Priority
  basis: 'rules' | 'ai'
  breakdown: CriterionScore[]
}

export interface ScorableCompany {
  companyName: string | null
  sector: string | null
  categoryTags: string[]
  address: string | null
  city: string | null
  region: string | null
  country: string | null
  website: string | null
  phone: string | null
}

export function priorityFor(score: number): Priority {
  if (score >= 80) return 'high'
  if (score >= 50) return 'medium'
  return 'low'
}

const round1 = (n: number) => Math.round(n * 10) / 10

function sectorRule(c: ScorableCompany, targets: string[]): { ratio: number; reason: string; params?: Record<string, string>; evidence: string[] } {
  if (targets.length === 0) return { ratio: 0.5, reason: 'sector_no_targets', evidence: [] }
  const companyKeys = new Set<string>()
  const sectorDef = matchSector(c.sector)
  if (sectorDef) companyKeys.add(sectorDef.key)
  const companyTokens = new Set([...tokens(c.sector), ...c.categoryTags.flatMap((t) => tokens(t.replace(/[=_]/g, ' ')))])
  for (const target of targets) {
    const def = matchSector(target)
    if (def && companyKeys.has(def.key)) return { ratio: 1, reason: 'sector_match', params: { target }, evidence: [c.sector ?? target] }
    const tt = tokens(target)
    if (tt.length > 0 && tt.every((t) => companyTokens.has(t))) return { ratio: 1, reason: 'sector_match', params: { target }, evidence: [c.sector ?? target] }
  }
  // Corrispondenza solo nel nome (indizio più debole).
  const nameTokens = new Set(tokens(c.companyName))
  for (const target of targets) {
    const def = matchSector(target)
    const syns = def ? def.synonyms : [target]
    if (syns.some((s) => tokens(s).length > 0 && tokens(s).every((t) => nameTokens.has(t)))) {
      return { ratio: 0.6, reason: 'sector_name_match', params: { target }, evidence: [c.companyName ?? ''] }
    }
  }
  return { ratio: 0, reason: 'sector_no_match', evidence: c.sector ? [c.sector] : [] }
}

function geographyRule(c: ScorableCompany, regions: string[], countries: string[]): { ratio: number; reason: string; params?: Record<string, string>; evidence: string[] } {
  if (regions.length === 0 && countries.length === 0) return { ratio: 0.5, reason: 'geo_no_targets', evidence: [] }
  const countryOk = countries.length === 0 || (c.country !== null && countries.includes(c.country))
  if (!countryOk) return { ratio: 0, reason: 'geo_country_mismatch', params: { country: c.country ?? '—' }, evidence: c.country ? [c.country] : [] }
  if (regions.length === 0) return { ratio: 1, reason: 'geo_country_match', params: { country: c.country ?? '' }, evidence: [c.country ?? ''] }
  const places = [c.city, c.region].filter((v): v is string => !!v).map(fold)
  const hit = regions.find((r) => places.includes(fold(r)))
  if (hit) return { ratio: 1, reason: 'geo_region_match', params: { region: hit }, evidence: [c.city ?? c.region ?? hit] }
  return { ratio: countries.length ? 0.4 : 0, reason: 'geo_region_mismatch', params: { place: c.city ?? c.region ?? '—' }, evidence: [] }
}

function completenessRule(c: ScorableCompany) {
  const fields: [string, unknown][] = [
    ['name', c.companyName],
    ['location', c.address ?? c.city],
    ['website', c.website],
    ['phone', c.phone],
    ['sector', c.sector],
  ]
  const present = fields.filter(([, v]) => !!v).map(([k]) => k)
  const missing = fields.filter(([, v]) => !v).map(([k]) => k)
  return { ratio: present.length / fields.length, reason: 'completeness', params: { present: present.length, total: fields.length, missing: missing.join(',') }, evidence: present }
}

export function scoreLead(company: ScorableCompany, profile: IcpProfile, analysis: AnalysisResult | null): ScoreResult {
  const w = profile.weights
  const breakdown: CriterionScore[] = []

  // 1. Settore
  const s = sectorRule(company, profile.targetSectors)
  let sectorRatio = s.ratio
  let sectorReason = s.reason
  let sectorAi: string | undefined
  if (analysis && s.ratio < 1 && profile.targetSectors.length > 0) {
    const aiRatio = analysis.fit.sector_rating / 10
    if (aiRatio > sectorRatio) {
      sectorRatio = aiRatio
      sectorReason = 'sector_ai'
      sectorAi = analysis.fit.sector_reason
    }
  }
  breakdown.push({ key: 'sector', points: round1(w.sector * sectorRatio), max: w.sector, reason: sectorReason, params: s.params, aiReason: sectorAi, evidence: s.evidence })

  // 2. Area geografica
  const g = geographyRule(company, profile.targetRegions, profile.targetCountries)
  breakdown.push({ key: 'geography', points: round1(w.geography * g.ratio), max: w.geography, reason: g.reason, params: g.params, evidence: g.evidence })

  // 3. Coerenza con il cliente ideale (richiede AI e un profilo configurato)
  if (!profile.idealCustomer && !profile.servicesDescription) {
    breakdown.push({ key: 'icp', points: 0, max: w.icp, reason: 'icp_not_configured', evidence: [] })
  } else if (!analysis) {
    breakdown.push({ key: 'icp', points: 0, max: w.icp, reason: 'icp_requires_ai', evidence: [] })
  } else {
    breakdown.push({
      key: 'icp',
      points: round1((w.icp * analysis.fit.icp_rating) / 10),
      max: w.icp,
      reason: 'icp_ai',
      params: { rating: analysis.fit.icp_rating },
      aiReason: analysis.fit.icp_reason,
      evidence: [],
    })
  }

  // 4. Segnali commerciali verificabili: solo quelli con evidenza trovata nel testo sorgente.
  if (!analysis) {
    breakdown.push({ key: 'signals', points: 0, max: w.signals, reason: 'signals_require_ai', evidence: [] })
  } else {
    const verified = analysis.signals.filter((x) => x.verified)
    breakdown.push({
      key: 'signals',
      points: round1((w.signals * Math.min(verified.length, 3)) / 3),
      max: w.signals,
      reason: verified.length ? 'signals_verified' : 'signals_none',
      params: { count: verified.length },
      evidence: verified.map((x) => `${x.signal}: “${x.evidence}”`),
    })
  }

  // 5. Completezza dei dati
  const comp = completenessRule(company)
  breakdown.push({ key: 'completeness', points: round1(w.completeness * comp.ratio), max: w.completeness, reason: comp.reason, params: comp.params, evidence: comp.evidence })

  const score = Math.max(0, Math.min(100, Math.round(breakdown.reduce((a, b) => a + b.points, 0))))
  return { score, priority: priorityFor(score), basis: analysis ? 'ai' : 'rules', breakdown }
}
