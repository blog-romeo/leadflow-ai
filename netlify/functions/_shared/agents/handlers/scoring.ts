import { fold } from '../../lead-finder/normalize'
import { scoreLead, priorityFor, type ScorableCompany, type ScoreResult } from '../../lead-finder/scoring'
import type { AnalysisResult } from '../../lead-finder/analysis/schema'
import type { CandidateRecord } from '../../lead-finder/store'
import type { IcpProfile } from '../../lead-finder/types'
import type { StepContext, StepHandler, StepResult } from '../engine'
import type { AgentStore } from '../store'
import type { LeadFinderStore } from '../../lead-finder/store'
import type { SalesStore } from '../../sales-agent/store'
import type { ProspectingParams } from '../validation'

/**
 * AI Lead Scoring Agent.
 *
 * Criteri configurabili (pesi del profilo ICP già esistenti): settore, area geografica, cliente ideale,
 * segnali verificabili, completezza dei dati; in più, se configurato, lo STORICO COMMERCIALE autorizzato
 * dell'organizzazione (tasso di trattative vinte nel settore, solo dati propri e solo con un campione
 * minimo). Produce punteggio 0–100, priorità, motivazione, evidenze, dati mancanti e un suggerimento.
 *
 * Il punteggio è un indice di COMPATIBILITÀ con criteri dichiarati, non una probabilità di acquisto:
 * nessun modello statistico è stato validato su dati reali.
 */
export type Suggestion = 'prepare_strategy' | 'run_research' | 'complete_data' | 'review_in_crm' | 'deprioritize' | 'none_excluded'

export interface HistoryCriterion {
  weight: number
  applied: boolean
  reason: 'history_disabled' | 'history_insufficient' | 'history_win_rate'
  won: number
  lost: number
  min_sample: number
}

export interface AgentScore extends ScoreResult {
  history: HistoryCriterion
  missing: string[]
  evidence: string[]
  suggestion: Suggestion
  measure: 'compatibility_index'
}

export function toScorable(c: Pick<CandidateRecord, 'companyName' | 'sector' | 'categoryTags' | 'address' | 'city' | 'region' | 'country' | 'website' | 'phone'>): ScorableCompany {
  return { companyName: c.companyName, sector: c.sector, categoryTags: c.categoryTags, address: c.address, city: c.city, region: c.region, country: c.country, website: c.website, phone: c.phone }
}

export function agentScore(
  company: ScorableCompany,
  profile: IcpProfile,
  analysis: AnalysisResult | null,
  opts: { history: Record<string, { won: number; lost: number }> | null; historyWeight: number; minSample: number; inCrm: boolean; excluded: boolean },
): AgentScore {
  const base = scoreLead(company, profile, analysis)
  const weight = Math.max(0, Math.min(30, opts.historyWeight))
  const key = company.sector ? fold(company.sector) : ''
  const h = opts.history && key ? opts.history[key] : undefined
  const sample = h ? h.won + h.lost : 0
  const history: HistoryCriterion = {
    weight,
    applied: false,
    reason: weight === 0 || !opts.history ? 'history_disabled' : 'history_insufficient',
    won: h?.won ?? 0,
    lost: h?.lost ?? 0,
    min_sample: opts.minSample,
  }
  let score = base.score
  if (weight > 0 && h && sample >= opts.minSample) {
    score = Math.round((base.score * (100 - weight)) / 100 + weight * (h.won / sample))
    history.applied = true
    history.reason = 'history_win_rate'
  }
  score = Math.max(0, Math.min(100, score))
  const completeness = base.breakdown.find((b) => b.key === 'completeness')
  const missing = [
    ...String(completeness?.params?.missing ?? '')
      .split(',')
      .filter(Boolean),
    ...(analysis?.missing_information ?? []).slice(0, 5),
  ]
  const evidence = base.breakdown.flatMap((b) => b.evidence).filter(Boolean).slice(0, 12)
  const priority = priorityFor(score)
  let suggestion: Suggestion
  if (opts.excluded) suggestion = 'none_excluded'
  else if (opts.inCrm) suggestion = 'review_in_crm'
  else if (!analysis) suggestion = 'run_research'
  else if (priority === 'high') suggestion = 'prepare_strategy'
  else if (missing.some((m) => m === 'website' || m === 'phone' || m === 'location')) suggestion = 'complete_data'
  else suggestion = priority === 'low' ? 'deprioritize' : 'prepare_strategy'
  return { ...base, score, priority, history, missing, evidence, suggestion, measure: 'compatibility_index' }
}

async function loadCandidates(lf: LeadFinderStore, org: string, ids: string[]): Promise<CandidateRecord[]> {
  const out: CandidateRecord[] = []
  for (let i = 0; i < ids.length; i += 50) out.push(...(await lf.getCandidates(org, ids.slice(i, i + 50))))
  const order = new Map(ids.map((id, i) => [id, i]))
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

export const scoringHandler: StepHandler = {
  agent: 'scoring',
  async run(ctx: StepContext): Promise<StepResult> {
    const p = ctx.workflow.params as unknown as ProspectingParams
    const ids = (ctx.prior(1)?.candidate_ids as string[] | undefined) ?? []
    const lf = ctx.services.leadFinder
    const profile = await ctx.tools.call('profile.read', {}, () => lf.getProfile(ctx.orgId))
    const weight = ctx.config.config.history_weight ?? 0
    const minSample = ctx.config.config.min_history_sample ?? 10
    const history = weight > 0 ? await ctx.tools.call('crm.history.read', {}, () => ctx.store.sectorHistory(ctx.orgId)) : null
    const candidates = await ctx.tools.call('candidates.read', { count: ids.length }, () => loadCandidates(lf, ctx.orgId, ids))

    const ranked = []
    for (const c of candidates) {
      const s = agentScore(toScorable(c), profile, c.analysis, { history, historyWeight: weight, minSample, inCrm: c.status === 'saved', excluded: c.status === 'excluded' })
      if (c.canStoreContent && (c.score !== s.score || c.scoreBasis !== s.basis)) {
        await ctx.tools.call('scores.write', { candidate_id: c.id, score: s.score }, () =>
          lf.updateCandidate(ctx.orgId, c.id, { score: { score: s.score, priority: s.priority, basis: s.basis, breakdown: s.breakdown } }),
        )
      }
      ranked.push({
        candidate_id: c.id,
        company_name: c.companyName,
        city: c.city,
        website: c.website,
        status: c.status,
        lead_id: c.leadId,
        can_save_to_crm: c.canSaveToCrm && c.canStoreContent,
        score: s.score,
        priority: s.priority,
        basis: s.basis,
        breakdown: s.breakdown,
        history: s.history,
        missing: s.missing,
        evidence: s.evidence,
        suggestion: s.suggestion,
      })
    }
    ranked.sort((a, b) => b.score - a.score)
    const eligible = ranked.filter((r) => r.status !== 'excluded' && r.can_save_to_crm && r.score >= p.min_score)
    const output = {
      ranked,
      eligible_ids: eligible.map((r) => r.candidate_id),
      counts: {
        total: ranked.length,
        eligible: eligible.length,
        below_min_score: ranked.filter((r) => r.score < p.min_score).length,
        high: ranked.filter((r) => r.priority === 'high').length,
        medium: ranked.filter((r) => r.priority === 'medium').length,
        low: ranked.filter((r) => r.priority === 'low').length,
        with_analysis: ranked.filter((r) => r.basis === 'ai').length,
      },
      min_score: p.min_score,
      measure: 'compatibility_index',
    }
    return { output, itemsTotal: ranked.length, itemsFailed: 0 }
  },
}

/**
 * Ricalcolo del punteggio quando cambiano le informazioni (profilo ICP, analisi, dati del lead o storico).
 * Deterministico: nessun credito AI consumato.
 */
export async function rescore(
  deps: { leadFinder: LeadFinderStore; sales: SalesStore; store: AgentStore },
  ctx: { orgId: string; config: { history_weight?: number; min_history_sample?: number } },
  input: { candidate_ids: string[]; lead_ids: string[] },
) {
  const profile = await deps.leadFinder.getProfile(ctx.orgId)
  const weight = ctx.config.history_weight ?? 0
  const history = weight > 0 ? await deps.store.sectorHistory(ctx.orgId) : null
  const minSample = ctx.config.min_history_sample ?? 10
  const results: { id: string; type: 'candidate' | 'lead'; score: number | null; previous: number | null; outcome: 'updated' | 'unchanged' | 'not_found' | 'not_allowed' }[] = []

  for (const c of await loadCandidates(deps.leadFinder, ctx.orgId, input.candidate_ids)) {
    if (!c.canStoreContent) {
      results.push({ id: c.id, type: 'candidate', score: null, previous: c.score, outcome: 'not_allowed' })
      continue
    }
    const s = agentScore(toScorable(c), profile, c.analysis, { history, historyWeight: weight, minSample, inCrm: c.status === 'saved', excluded: c.status === 'excluded' })
    const changed = s.score !== c.score || s.basis !== c.scoreBasis
    if (changed) await deps.leadFinder.updateCandidate(ctx.orgId, c.id, { score: { score: s.score, priority: s.priority, basis: s.basis, breakdown: s.breakdown } })
    results.push({ id: c.id, type: 'candidate', score: s.score, previous: c.score, outcome: changed ? 'updated' : 'unchanged' })
  }
  const foundCandidates = new Set(results.map((r) => r.id))
  for (const id of input.candidate_ids) if (!foundCandidates.has(id)) results.push({ id, type: 'candidate', score: null, previous: null, outcome: 'not_found' })

  for (const leadId of input.lead_ids) {
    const raw = await deps.sales.getLead(ctx.orgId, leadId)
    if (!raw || raw.lead.deleted_at) {
      results.push({ id: leadId, type: 'lead', score: null, previous: null, outcome: 'not_found' })
      continue
    }
    const a = raw.businessAnalysis as unknown as AnalysisResult | null
    const analysis = a && typeof a === 'object' && a.fit && Array.isArray(a.signals) ? a : null
    const l = raw.lead
    const s = agentScore(
      { companyName: l.company_name, sector: l.industry, categoryTags: [], address: null, city: l.city, region: l.region, country: l.country, website: l.website, phone: l.phone },
      profile,
      analysis,
      { history, historyWeight: weight, minSample, inCrm: true, excluded: false },
    )
    const changed = s.score !== l.score
    if (changed) await deps.store.updateLeadScore(ctx.orgId, leadId, { score: s.score, priority: s.priority, basis: s.basis, breakdown: s.breakdown })
    results.push({ id: leadId, type: 'lead', score: s.score, previous: l.score, outcome: changed ? 'updated' : 'unchanged' })
  }
  return { results, updated: results.filter((r) => r.outcome === 'updated').length, measure: 'compatibility_index' as const }
}
