import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { AnalysisResult } from '../../lead-finder/analysis/schema'
import type { ScorableCompany } from '../../lead-finder/scoring'
import type { IcpProfile, Priority } from '../../lead-finder/types'
import { checkText, factSupported, type Warning } from '../../sales-agent/postcheck'
import type { AiCaller } from '../../sales-agent/service'
import { agentScore } from '../handlers/scoring'
import { strategyJsonSchema, strategySchema } from '../handlers/strategy'

/**
 * AI Quality Evaluation (Prompt 9).
 *
 * Tre valutazioni, tutte su dataset SINTETICI ed etichettati, separati dai dati dei clienti
 * (cartella eval/datasets, mai letta dalle functions in produzione):
 *  1. Scoring Agent: concordanza della priorità con etichette scritte a mano (matrice di confusione).
 *  2. Controlli dell'output AI: capacità di intercettare schema non valido, email inventate, promesse,
 *     fatti non supportati, URL/telefoni/importi non presenti nei dati (recall per difetto, falsi positivi).
 *  3. (facoltativa, "live") Strategia generata da un modello reale sui contesti sintetici: percentuale di
 *     JSON validi, evidenze presenti, informazioni non supportate, token, durata. Eseguita solo se viene
 *     passato un AiCaller reale (AI_EVAL_LIVE=1 con credenziali): altrimenti è dichiarata "non eseguita".
 *
 * Nessun numero viene inventato: ogni metrica è calcolata qui; ciò che non è misurato è null.
 */
const here = dirname(fileURLToPath(import.meta.url))
const load = <T>(name: string): T => JSON.parse(readFileSync(join(here, 'datasets', name), 'utf8')) as T

interface ScoringCase {
  id: string
  company: Partial<ScorableCompany> & { companyName: string }
  analysis: { fit: [number, number]; verified_signals: number; unverified_signals?: number } | null
  expected_priority: Priority
}
interface ScoringDataset { synthetic: true; profile: IcpProfile; cases: ScoringCase[] }

interface ValidatorCase { id: string; patch: Record<string, unknown>; expect: string[] }
interface ValidatorDataset { synthetic: true; context: { text: string; allowed: { urls: string[]; phones: string[]; amounts: number[] } }; base: Record<string, unknown>; cases: ValidatorCase[] }

function syntheticAnalysis(c: ScoringCase): AnalysisResult | null {
  if (!c.analysis) return null
  const now = new Date(0).toISOString()
  const signals = [
    ...Array.from({ length: c.analysis.verified_signals }, (_, i) => ({ signal: `Segnale verificato ${i + 1}`, evidence: `estratto ${i + 1}`, verified: true })),
    ...Array.from({ length: c.analysis.unverified_signals ?? 0 }, (_, i) => ({ signal: `Segnale non verificato ${i + 1}`, evidence: '', verified: false })),
  ]
  return {
    version: 1,
    model: 'synthetic',
    analyzed_at: now,
    website: { url: c.company.website ?? null, status: c.company.website ? 'analyzed' : 'no_website', fetched_at: now },
    sector: { value: c.company.sector ?? 'n/d', basis: 'hypothesis', evidence: '' },
    activity_description: { value: 'n/d', basis: 'hypothesis', evidence: '' },
    verified_facts: [],
    hypotheses: [],
    digital_needs: [],
    opportunities: [],
    missing_information: [],
    fit: { sector_rating: c.analysis.fit[0], sector_reason: 'synthetic', icp_rating: c.analysis.fit[1], icp_reason: 'synthetic' },
    signals,
  } as unknown as AnalysisResult
}

export interface ScoringEval {
  cases: number
  agreement: number
  confusion: Record<Priority, Record<Priority, number>>
  disagreements: { id: string; expected: Priority; got: Priority; score: number }[]
}

export function evaluateScoring(): ScoringEval {
  const ds = load<ScoringDataset>('scoring.synthetic.json')
  if (ds.synthetic !== true) throw new Error('dataset_not_labeled_synthetic')
  const P: Priority[] = ['high', 'medium', 'low']
  const confusion = Object.fromEntries(P.map((e) => [e, Object.fromEntries(P.map((g) => [g, 0]))])) as ScoringEval['confusion']
  const disagreements: ScoringEval['disagreements'] = []
  let ok = 0
  for (const c of ds.cases) {
    const company: ScorableCompany = { sector: null, categoryTags: [], address: null, city: null, region: null, country: null, website: null, phone: null, ...c.company }
    const r = agentScore(company, ds.profile, syntheticAnalysis(c), { history: null, historyWeight: 0, minSample: 10, inCrm: false, excluded: false })
    confusion[c.expected_priority][r.priority]++
    if (r.priority === c.expected_priority) ok++
    else disagreements.push({ id: c.id, expected: c.expected_priority, got: r.priority, score: r.score })
  }
  return { cases: ds.cases.length, agreement: Math.round((ok / ds.cases.length) * 1000) / 1000, confusion, disagreements }
}

/** Stessa catena di controlli del Sales Strategy Agent (schema zod + postcheck + verifica dei fatti). */
export function checkStrategyOutput(raw: unknown, context: ValidatorDataset['context']): { schemaValid: boolean; flags: string[] } {
  const parsed = strategySchema.safeParse(raw)
  if (!parsed.success) return { schemaValid: false, flags: ['schema_invalid'] }
  const o = parsed.data
  const warnings: Warning[] = []
  const texts = [o.service_rationale, o.value_proposition, o.call_to_action, ...o.objections.flatMap((x) => [x.objection, x.response]), ...o.approach.steps, ...(o.draft ? [o.draft.subject, o.draft.body] : [])]
  for (const t of texts) warnings.push(...checkText(t, context.allowed).warnings)
  if (o.opportunity.basis === 'fact' && !factSupported(o.opportunity.evidence, context.text)) warnings.push({ code: 'unverified_fact' })
  return { schemaValid: true, flags: [...new Set(warnings.map((w) => w.code))] }
}

export interface ValidatorEval {
  cases: number
  defects_labeled: number
  defects_detected: number
  recall: number | null
  false_positive_cases: string[]
  missed: { id: string; flag: string }[]
  by_flag: Record<string, { labeled: number; detected: number }>
}

export function evaluateValidators(): ValidatorEval {
  const ds = load<ValidatorDataset>('strategy-outputs.synthetic.json')
  if (ds.synthetic !== true) throw new Error('dataset_not_labeled_synthetic')
  const byFlag: ValidatorEval['by_flag'] = {}
  const missed: ValidatorEval['missed'] = []
  const fp: string[] = []
  let labeled = 0
  let detected = 0
  for (const c of ds.cases) {
    const raw = { ...ds.base, ...c.patch }
    const r = checkStrategyOutput(raw, ds.context)
    for (const f of c.expect) {
      labeled++
      byFlag[f] ??= { labeled: 0, detected: 0 }
      byFlag[f].labeled++
      if (r.flags.includes(f)) {
        detected++
        byFlag[f].detected++
      } else missed.push({ id: c.id, flag: f })
    }
    if (c.expect.length === 0 && r.flags.length > 0) fp.push(`${c.id}:${r.flags.join('+')}`)
  }
  return { cases: ds.cases.length, defects_labeled: labeled, defects_detected: detected, recall: labeled ? Math.round((detected / labeled) * 1000) / 1000 : null, false_positive_cases: fp, missed, by_flag: byFlag }
}

export interface LiveEval {
  executed: boolean
  reason?: string
  calls: number
  json_valid_rate: number | null
  fact_with_evidence_rate: number | null
  unsupported_rate: number | null
  avg_ms: number | null
  tokens_input: number
  tokens_output: number
  model: string | null
}

/** Valutazione "live" della strategia su contesti sintetici. Senza AiCaller reale non viene eseguita. */
export async function evaluateStrategyLive(ai: AiCaller | null, opts: { runs?: number; now?: () => number } = {}): Promise<LiveEval> {
  const empty: LiveEval = { executed: false, calls: 0, json_valid_rate: null, fact_with_evidence_rate: null, unsupported_rate: null, avg_ms: null, tokens_input: 0, tokens_output: 0, model: null }
  if (!ai) return { ...empty, reason: 'no_ai_credentials' }
  const ds = load<ValidatorDataset>('strategy-outputs.synthetic.json')
  const now = opts.now ?? (() => Date.now())
  const runs = Math.max(1, Math.min(opts.runs ?? 5, 20))
  let valid = 0
  let factsWithEvidence = 0
  let facts = 0
  let unsupported = 0
  let ms = 0
  let tin = 0
  let tout = 0
  let model: string | null = null
  for (let i = 0; i < runs; i++) {
    const t0 = now()
    const res = await ai({
      system: 'Sei un assistente commerciale. Usa SOLO i dati forniti. Restituisci JSON conforme allo schema. Dati sintetici di valutazione.',
      user: `<dati_non_attendibili>${ds.context.text}</dati_non_attendibili>\nServizio: booking engine (id: booking).`,
      schemaName: 'sales_strategy',
      schema: strategyJsonSchema,
      maxOutputTokens: 1500,
    })
    ms += now() - t0
    tin += res.usage.input_tokens
    tout += res.usage.output_tokens
    model = res.model
    const r = checkStrategyOutput(res.json, ds.context)
    if (r.schemaValid) valid++
    const parsed = strategySchema.safeParse(res.json)
    if (parsed.success && parsed.data.opportunity.basis === 'fact') {
      facts++
      if (parsed.data.opportunity.evidence.trim()) factsWithEvidence++
    }
    if (r.flags.some((f) => f !== 'schema_invalid')) unsupported++
  }
  return {
    executed: true,
    calls: runs,
    json_valid_rate: valid / runs,
    fact_with_evidence_rate: facts ? factsWithEvidence / facts : null,
    unsupported_rate: unsupported / runs,
    avg_ms: Math.round(ms / runs),
    tokens_input: tin,
    tokens_output: tout,
    model,
  }
}
