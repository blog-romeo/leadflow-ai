import { createHash } from 'node:crypto'
import { deduplicate } from '../../lead-finder/dedup'
import { createOsmOverpassAdapter, mapOsmElement } from '../../lead-finder/providers/osmOverpass'
import { matchSector } from '../../lead-finder/sectors'
import { fold } from '../../lead-finder/normalize'
import type { AnalysisResult } from '../../lead-finder/analysis/schema'
import type { IcpProfile } from '../../lead-finder/types'
import { looksLikeInjection } from '../../sales-agent/sanitize'
import { validateActionOutput } from '../envelope'
import { agentScore } from '../handlers/scoring'
import { DEFAULT_BLOCKING, reviewStep, type ReviewCode } from '../reviewer'
import type { Dataset, Split } from './datasets/types'
import { discoveryV1 } from './datasets/discovery'
import { injectionV1 } from './datasets/injection'
import { ICP_PROFILE, leadScoringV2, type ScoringCase } from './datasets/leadScoring'
import { llmTasksV1 } from './datasets/llmTasks'
import { outputReviewV1 } from './datasets/outputReview'
import { providerErrorsV1 } from './datasets/providerErrors'
import { sectorClassificationV1 } from './datasets/sectorClassification'

/**
 * AI Benchmark Engine (Prompt 12). Benchmark RIPETIBILI e deterministici sui dataset sintetici versionati.
 *
 * Cosa misura (solo ciò che è realmente calcolabile qui):
 *  • precision / recall / F1 (macro per le classi, micro per i difetti), accuratezza;
 *  • astensione corretta (settore non coperto, dati insufficienti per una strategia);
 *  • validità degli output (schemi), copertura delle fonti, violazioni di policy non intercettate;
 *  • latenza dei componenti (ms, in processo), tasso di completamento.
 * I compiti che richiedono un modello reale sono riportati come "not_executed" senza un AiCaller autorizzato.
 * Nessun numero inventato: ogni valore nel report è calcolato da questo modulo durante l'esecuzione.
 */
export const BENCHMARK_VERSION = '1.0.0'

export interface Prf { precision: number | null; recall: number | null; f1: number | null; support: number }
const r3 = (n: number) => Math.round(n * 1000) / 1000
export function prf(tp: number, fp: number, fn: number): Prf {
  const p = tp + fp ? tp / (tp + fp) : null
  const r = tp + fn ? tp / (tp + fn) : null
  const f = p !== null && r !== null && p + r > 0 ? (2 * p * r) / (p + r) : p === null && r === null ? null : 0
  return { precision: p === null ? null : r3(p), recall: r === null ? null : r3(r), f1: f === null ? null : r3(f), support: tp + fn }
}

/** Macro P/R/F1 su classi (null → classe "none"). */
export function macro(pairs: { expected: string | null; got: string | null }[]): { accuracy: number; macro: Prf; per_class: Record<string, Prf> } {
  const lab = (v: string | null) => v ?? 'none'
  const classes = [...new Set(pairs.flatMap((p) => [lab(p.expected), lab(p.got)]))]
  const per: Record<string, Prf> = {}
  for (const c of classes) {
    const tp = pairs.filter((p) => lab(p.expected) === c && lab(p.got) === c).length
    const fp = pairs.filter((p) => lab(p.expected) !== c && lab(p.got) === c).length
    const fn = pairs.filter((p) => lab(p.expected) === c && lab(p.got) !== c).length
    per[c] = prf(tp, fp, fn)
  }
  const withSupport = Object.values(per).filter((x) => x.support > 0)
  const avg = (k: 'precision' | 'recall' | 'f1') => r3(withSupport.reduce((a, x) => a + (x[k] ?? 0), 0) / Math.max(withSupport.length, 1))
  return { accuracy: r3(pairs.filter((p) => lab(p.expected) === lab(p.got)).length / Math.max(pairs.length, 1)), macro: { precision: avg('precision'), recall: avg('recall'), f1: avg('f1'), support: pairs.length }, per_class: per }
}

// ─── Configurazioni valutabili ────────────────────────────────────────────────
export interface SectorConfig { label: string; extraSynonyms: Record<string, string[]> }
export interface ScoringConfig { label: string; weights: IcpProfile['weights'] }
export interface ReviewConfig { label: string; reviewer: boolean }

export const BASELINE = {
  sector: { label: 'baseline:catalogo-settori', extraSynonyms: {} } as SectorConfig,
  scoring: { label: 'baseline:pesi-icp-default', weights: ICP_PROFILE.weights } as ScoringConfig,
  review: { label: 'baseline:schema+postcheck (Prompt 9)', reviewer: false } as ReviewConfig,
}

export function classifySector(input: string, cfg: SectorConfig): string | null {
  const base = matchSector(input)?.key ?? null
  if (base) return base
  const f = ` ${fold(input)} `
  for (const [key, syns] of Object.entries(cfg.extraSynonyms)) if (syns.some((s) => f.includes(` ${fold(s)} `))) return key
  return null
}

function scoringAnalysis(c: ScoringCase): AnalysisResult | null {
  if (!c.analysis) return null
  const signals = [
    ...Array.from({ length: c.analysis.verified }, (_, i) => ({ signal: `segnale ${i}`, evidence: `estratto ${i}`, verified: true })),
    ...Array.from({ length: c.analysis.unverified ?? 0 }, (_, i) => ({ signal: `ipotesi ${i}`, evidence: '', verified: false })),
  ]
  return { fit: { sector_rating: c.analysis.fit[0], sector_reason: 'sintetico', icp_rating: c.analysis.fit[1], icp_reason: 'sintetico' }, signals, missing_information: [] } as unknown as AnalysisResult
}

export function scorePriority(c: ScoringCase, cfg: ScoringConfig): { priority: string; score: number; explained: boolean } {
  const co = c.company
  const r = agentScore(
    { companyName: co.name, sector: co.sector, categoryTags: co.tags ?? [], address: co.address ? 'Via Sintetica 1' : null, city: co.city, region: null, country: co.country, website: co.website ? 'https://x.example' : null, phone: co.phone ? '+39 06 0000000' : null },
    { ...ICP_PROFILE, weights: cfg.weights },
    scoringAnalysis(c),
    { history: null, historyWeight: 0, minSample: 10, inCrm: false, excluded: false },
  )
  // Spiegabilità: ogni punteggio deve avere il dettaglio per criterio.
  return { priority: r.priority, score: r.score, explained: r.breakdown.length === 5 && r.breakdown.every((b) => typeof b.reason === 'string') }
}

/** Codici segnalati da una configurazione di controllo su un output. */
export function detectIssues(c: (typeof outputReviewV1.splits.test)[number], cfg: ReviewConfig): string[] {
  const out = new Set<string>()
  if (!validateActionOutput(c.action, c.output).ok) out.add('format_error')
  // Baseline: il postcheck del Prompt 9 marca i fatti non verificati come avvisi sull'elemento.
  for (const it of (Array.isArray(c.output.strategies) ? c.output.strategies : []) as { warnings?: { code: string }[] }[]) {
    if ((it.warnings ?? []).some((w) => w.code === 'unverified_fact')) out.add('claim_not_verified')
  }
  if (cfg.reviewer) for (const f of reviewStep(c.action, c.output, c.context ?? {}, []).findings) out.add(f.code)
  return [...out]
}

// ─── Suite ───────────────────────────────────────────────────────────────────
export interface SuiteResult {
  suite: string
  dataset: { id: string; version: string; synthetic: true }
  split: Split
  config: string
  status: 'executed' | 'not_executed'
  reason?: string
  cases: number
  metrics: Record<string, unknown>
  ms: number
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now()
  const value = fn()
  return { value, ms: r3(performance.now() - t0) }
}
const meta = (d: Dataset<unknown>) => ({ id: d.id, version: d.version, synthetic: true as const })

export function runSectorSuite(split: Split, cfg: SectorConfig): SuiteResult {
  const cases = sectorClassificationV1.splits[split]
  const { value: pairs, ms } = timed(() => cases.map((c) => ({ id: c.id, expected: c.expected, got: classifySector(c.input, cfg) })))
  const m = macro(pairs)
  const abst = pairs.filter((p) => p.expected === null)
  return {
    suite: 'sector_classification', dataset: meta(sectorClassificationV1), split, config: cfg.label, status: 'executed', cases: cases.length, ms,
    metrics: { accuracy: m.accuracy, macro_precision: m.macro.precision, macro_recall: m.macro.recall, macro_f1: m.macro.f1, correct_abstention_rate: abst.length ? r3(abst.filter((p) => p.got === null).length / abst.length) : null, wrong_ids: pairs.filter((p) => p.expected !== p.got).map((p) => p.id) },
  }
}

export function runScoringSuite(split: Split, cfg: ScoringConfig): SuiteResult {
  const cases = leadScoringV2.splits[split]
  const { value: rows, ms } = timed(() => cases.map((c) => ({ id: c.id, expected: c.expected, ...scorePriority(c, cfg) })))
  const m = macro(rows.map((r) => ({ expected: r.expected, got: r.priority })))
  return {
    suite: 'lead_scoring', dataset: meta(leadScoringV2), split, config: cfg.label, status: 'executed', cases: cases.length, ms,
    metrics: { accuracy: m.accuracy, macro_precision: m.macro.precision, macro_recall: m.macro.recall, macro_f1: m.macro.f1, explained_rate: r3(rows.filter((r) => r.explained).length / rows.length), score_is_probability: false, wrong_ids: rows.filter((r) => r.expected !== r.priority).map((r) => `${r.id}:${r.priority}/${r.score}`) },
  }
}

export function runInjectionSuite(split: Split): SuiteResult {
  const cases = injectionV1.splits[split]
  const { value: rows, ms } = timed(() => cases.map((c) => ({ id: c.id, expected: c.injection, got: looksLikeInjection(c.text) })))
  const tp = rows.filter((r) => r.expected && r.got).length
  const fp = rows.filter((r) => !r.expected && r.got).length
  const fn = rows.filter((r) => r.expected && !r.got).length
  return { suite: 'prompt_injection', dataset: meta(injectionV1), split, config: 'baseline:sanitize.ts', status: 'executed', cases: cases.length, ms, metrics: { ...prf(tp, fp, fn), missed_ids: rows.filter((r) => r.expected && !r.got).map((r) => r.id), false_positive_ids: rows.filter((r) => !r.expected && r.got).map((r) => r.id) } }
}

export function runReviewSuite(split: Split, cfg: ReviewConfig): SuiteResult {
  const cases = outputReviewV1.splits[split]
  const { value: rows, ms } = timed(() => cases.map((c) => ({ id: c.id, expected: new Set(c.expected), got: new Set(detectIssues(c, cfg)) })))
  let tp = 0, fp = 0, fn = 0
  for (const r of rows) {
    for (const g of r.got) (r.expected.has(g) ? tp++ : fp++)
    for (const e of r.expected) if (!r.got.has(e)) fn++
  }
  const insufficient = rows.filter((r) => r.expected.has('strategy_unsupported'))
  return {
    suite: 'output_review', dataset: meta(outputReviewV1), split, config: cfg.label, status: 'executed', cases: cases.length, ms,
    metrics: {
      ...prf(tp, fp, fn),
      clean_cases_flagged: rows.filter((r) => r.expected.size === 0 && r.got.size > 0).map((r) => r.id),
      // Dati insufficienti: quota di strategie FACT senza evidenze effettivamente intercettate (astensione forzata).
      insufficient_data_detection: insufficient.length ? r3(insufficient.filter((r) => r.got.has('strategy_unsupported')).length / insufficient.length) : null,
      // Violazioni di policy che passerebbero senza segnalazione (difetti attesi non rilevati).
      undetected_defects: fn,
    },
  }
}

export async function runProviderErrorSuite(split: Split): Promise<SuiteResult> {
  const cases = providerErrorsV1.splits[split]
  const t0 = performance.now()
  const rows = []
  for (const c of cases) {
    const adapter = createOsmOverpassAdapter({ OVERPASS_API_URL: 'https://overpass.example/api/interpreter', OVERPASS_CONTACT: 'bench@example.test' }, (async () => new Response(c.body, { status: c.status })) as unknown as typeof fetch)
    const err = await adapter.search({ sector: 'hotel', location: 'Roma', country: 'IT', keywords: [], websiteFilter: 'any', maxResults: 5 }, { timeoutMs: 2000 }).then(() => null, (e: { code?: string; retryable?: boolean }) => e)
    rows.push({ id: c.id, ok: !!err && err.code === c.expectedCode && !!err.retryable === c.retryable })
  }
  return { suite: 'provider_errors', dataset: meta(providerErrorsV1), split, config: 'baseline:osmOverpass.ts', status: 'executed', cases: cases.length, ms: r3(performance.now() - t0), metrics: { accuracy: r3(rows.filter((r) => r.ok).length / rows.length), wrong_ids: rows.filter((r) => !r.ok).map((r) => r.id) } }
}

export function runDiscoverySuite(split: Split): SuiteResult {
  const cases = discoveryV1.splits[split]
  const { value: rows, ms } = timed(() =>
    cases.map((c) => {
      const mapped = c.elements.map((el) => mapOsmElement(el, { sector: 'hotel', location: 'Roma', country: 'IT' } as never, '2026-01-01T00:00:00.000Z')).filter((x): x is NonNullable<typeof x> => x !== null)
      const d = deduplicate({ batch: mapped, existingCandidates: [], crmKeys: new Set() })
      const kept = d.items.map((i) => i.company)
      const got = { kept: kept.length, duplicates: d.duplicatesInBatch, missingWebsite: kept.filter((k) => !k.website).length, missingPhone: kept.filter((k) => !k.phone).length }
      const sources = kept.filter((k) => /^https:\/\/www\.openstreetmap\.org\//.test(k.sourceUrl ?? '')).length
      return { id: c.id, exact: JSON.stringify(got) === JSON.stringify(c.expected), got, sources, kept: kept.length }
    }),
  )
  const kept = rows.reduce((a, r) => a + r.kept, 0)
  return { suite: 'discovery_normalization', dataset: meta(discoveryV1), split, config: 'baseline:normalize+dedup', status: 'executed', cases: cases.length, ms, metrics: { exact_match_rate: r3(rows.filter((r) => r.exact).length / rows.length), source_coverage: kept ? r3(rows.reduce((a, r) => a + r.sources, 0) / kept) : null, mismatches: rows.filter((r) => !r.exact).map((r) => ({ id: r.id, got: r.got })) } }
}

export function llmSuiteNotExecuted(split: Split): SuiteResult {
  return { suite: 'llm_strategy', dataset: meta(llmTasksV1), split, config: 'n/a', status: 'not_executed', reason: 'requires_authorized_model_access', cases: llmTasksV1.splits[split].length, ms: 0, metrics: {} }
}

// ─── Ottimizzazione su TRAIN, scelta su VALIDATION, confronto su TEST ─────────
/** Sinonimi aggiuntivi ricavati SOLO dagli errori dello split di train (ottimizzazione di regole, non fine-tuning). */
export function deriveSectorCandidate(): SectorConfig {
  const extra: Record<string, string[]> = {}
  for (const c of sectorClassificationV1.splits.train) {
    if (c.expected && classifySector(c.input, BASELINE.sector) !== c.expected) {
      // Parola più distintiva del testo mal classificato (la più lunga), associata al settore atteso.
      const word = fold(c.input).split(' ').filter((w) => w.length >= 5).sort((a, b) => b.length - a.length)[0]
      if (word) (extra[c.expected] ??= []).push(word)
    }
  }
  return { label: 'candidate:sinonimi-da-train', extraSynonyms: extra }
}

const WEIGHT_GRID: IcpProfile['weights'][] = [
  { sector: 30, geography: 20, icp: 25, signals: 15, completeness: 10 },
  { sector: 25, geography: 25, icp: 25, signals: 15, completeness: 10 },
  { sector: 30, geography: 25, icp: 25, signals: 15, completeness: 5 },
  { sector: 30, geography: 20, icp: 30, signals: 15, completeness: 5 },
  { sector: 25, geography: 20, icp: 30, signals: 20, completeness: 5 },
]

/** Pesi scelti massimizzando l'F1 macro su TRAIN; a parità, quello migliore su VALIDATION. Il TEST non è mai usato qui. */
export function deriveScoringCandidate(): { config: ScoringConfig; grid: { weights: IcpProfile['weights']; train_f1: number | null; validation_f1: number | null }[] } {
  const grid = WEIGHT_GRID.map((w) => {
    const cfg = { label: 'grid', weights: w }
    return { weights: w, train_f1: runScoringSuite('train', cfg).metrics.macro_f1 as number | null, validation_f1: runScoringSuite('validation', cfg).metrics.macro_f1 as number | null }
  })
  const best = [...grid].sort((a, b) => (b.train_f1 ?? 0) - (a.train_f1 ?? 0) || (b.validation_f1 ?? 0) - (a.validation_f1 ?? 0))[0]!
  return { config: { label: `candidate:pesi ${Object.values(best.weights).join('/')}`, weights: best.weights }, grid }
}

export interface Comparison {
  suite: string
  split: 'test'
  primary_metric: string
  baseline: { config: string; value: number | null }
  candidate: { config: string; value: number | null }
  delta: number | null
  safety: { metric: string; baseline: unknown; candidate: unknown; regressed: boolean }[]
  gate_passed: boolean
}

function compare(suite: string, metric: string, b: SuiteResult, c: SuiteResult, safety: { metric: string; worse: (bv: unknown, cv: unknown) => boolean }[] = []): Comparison {
  const bv = b.metrics[metric] as number | null
  const cv = c.metrics[metric] as number | null
  const s = safety.map((x) => ({ metric: x.metric, baseline: b.metrics[x.metric], candidate: c.metrics[x.metric], regressed: x.worse(b.metrics[x.metric], c.metrics[x.metric]) }))
  const delta = bv !== null && cv !== null ? r3(cv - bv) : null
  // Gate: nessun peggioramento della metrica principale e nessuna regressione di sicurezza sullo split di TEST.
  return { suite, split: 'test', primary_metric: metric, baseline: { config: b.config, value: bv }, candidate: { config: c.config, value: cv }, delta, safety: s, gate_passed: delta !== null && delta >= 0 && s.every((x) => !x.regressed) }
}

export function checkContamination(): { dataset: string; duplicate_ids: string[]; duplicate_inputs: string[] }[] {
  const all: Dataset<{ id: string } & Record<string, unknown>>[] = [sectorClassificationV1, leadScoringV2, injectionV1, outputReviewV1, providerErrorsV1, discoveryV1, llmTasksV1] as never
  return all.map((d) => {
    const ids = new Map<string, number>()
    const inputs = new Map<string, string>()
    const dupInputs: string[] = []
    for (const split of ['train', 'validation', 'test'] as Split[]) {
      for (const c of d.splits[split]) {
        ids.set(c.id, (ids.get(c.id) ?? 0) + 1)
        const { id: _id, expected: _e, injection: _i, expectedCode: _c, retryable: _r, ...input } = c as Record<string, unknown>
        void _id; void _e; void _i; void _c; void _r
        const h = createHash('sha256').update(JSON.stringify(input)).digest('hex')
        const prev = inputs.get(h)
        if (prev && prev.split(':')[0] !== split) dupInputs.push(`${prev} ~ ${split}:${c.id}`)
        else if (!prev) inputs.set(h, `${split}:${c.id}`)
      }
    }
    return { dataset: `${d.id}@${d.version}`, duplicate_ids: [...ids].filter(([, n]) => n > 1).map(([id]) => id), duplicate_inputs: dupInputs }
  })
}

/** Codici bloccanti del Quality Reviewer: quanti output difettosi vengono fermati e quanti output corretti verrebbero bloccati per errore. */
export function runReviewerBlockingSuite(split: Split, codes: readonly ReviewCode[], label: string): SuiteResult {
  const cases = outputReviewV1.splits[split]
  const { value: rows, ms } = timed(() => cases.map((c) => ({ id: c.id, defective: c.expected.length > 0, blocked: reviewStep(c.action, c.output, c.context ?? {}, codes).blocking.length > 0 })))
  const defective = rows.filter((r) => r.defective)
  return {
    suite: 'reviewer_blocking', dataset: meta(outputReviewV1), split, config: label, status: 'executed', cases: cases.length, ms,
    metrics: { block_rate_defective: defective.length ? r3(defective.filter((r) => r.blocked).length / defective.length) : null, blocked_clean: rows.filter((r) => !r.defective && r.blocked).map((r) => r.id) },
  }
}

/** Configurazioni che il benchmark sa valutare (le altre non possono superare il gate). */
export const EVALUABLE_CONFIG_KEYS = ['quality_reviewer.blocking_codes'] as const

export interface CandidateInput { config_key: string; config: Record<string, unknown>; baseline_config: Record<string, unknown> | null }

export function evaluateCandidate(c: CandidateInput): { supported: boolean; comparison: Comparison | null; reason?: string } {
  if (c.config_key !== 'quality_reviewer.blocking_codes') return { supported: false, comparison: null, reason: 'no_benchmark_for_config_key' }
  const valid: ReviewCode[] = ['format_error', 'unsourced_fact', 'claim_not_verified', 'incomplete_output', 'duplicate_ids', 'duplicate_content', 'contradiction', 'strategy_unsupported']
  const parse = (cfg: Record<string, unknown> | null) => (Array.isArray(cfg?.blocking_codes) ? (cfg!.blocking_codes as unknown[]).filter((x): x is ReviewCode => valid.includes(x as ReviewCode)) : [...DEFAULT_BLOCKING])
  const base = runReviewerBlockingSuite('test', parse(c.baseline_config), 'active')
  const cand = runReviewerBlockingSuite('test', parse(c.config), 'candidate')
  return {
    supported: true,
    comparison: compare('reviewer_blocking', 'block_rate_defective', base, cand, [{ metric: 'blocked_clean', worse: (b, x) => (x as unknown[]).length > (b as unknown[]).length || (x as unknown[]).length > 0 }]),
  }
}

export interface BenchmarkReport {
  benchmark_version: string
  executed_at: string
  data_kind: 'synthetic'
  notice: string
  contamination: ReturnType<typeof checkContamination>
  suites: SuiteResult[]
  comparisons: Comparison[]
  candidates: { sector: SectorConfig; scoring: ScoringConfig; scoring_grid: ReturnType<typeof deriveScoringCandidate>['grid'] }
  /** Presente solo se è stata valutata una versione di configurazione candidata. */
  candidate_config?: { config_key: string; supported: boolean; reason?: string; gate_passed: boolean }
}

export async function runBenchmark(now = () => new Date(), candidate?: CandidateInput): Promise<BenchmarkReport> {
  const sectorCand = deriveSectorCandidate()
  const scoring = deriveScoringCandidate()
  const reviewCand: ReviewConfig = { label: 'candidate:schema+postcheck+Quality Reviewer', reviewer: true }
  const suites: SuiteResult[] = []
  for (const split of ['validation', 'test'] as Split[]) {
    suites.push(runSectorSuite(split, BASELINE.sector), runSectorSuite(split, sectorCand))
    suites.push(runScoringSuite(split, BASELINE.scoring), runScoringSuite(split, scoring.config))
    suites.push(runReviewSuite(split, BASELINE.review), runReviewSuite(split, reviewCand))
    suites.push(runInjectionSuite(split), runDiscoverySuite(split), await runProviderErrorSuite(split), llmSuiteNotExecuted(split))
  }
  const pick = (suite: string, cfg: string) => suites.find((s) => s.suite === suite && s.split === 'test' && s.config === cfg)!
  const comparisons = [
    compare('sector_classification', 'macro_f1', pick('sector_classification', BASELINE.sector.label), pick('sector_classification', sectorCand.label), [{ metric: 'correct_abstention_rate', worse: (b, c) => (c as number) < (b as number) }]),
    compare('lead_scoring', 'macro_f1', pick('lead_scoring', BASELINE.scoring.label), pick('lead_scoring', scoring.config.label), [{ metric: 'explained_rate', worse: (b, c) => (c as number) < (b as number) }]),
    compare('output_review', 'f1', pick('output_review', BASELINE.review.label), pick('output_review', reviewCand.label), [{ metric: 'clean_cases_flagged', worse: (b, c) => (c as unknown[]).length > (b as unknown[]).length }]),
  ]
  let candidateConfig: BenchmarkReport['candidate_config']
  if (candidate) {
    const ev = evaluateCandidate(candidate)
    if (ev.comparison) comparisons.push(ev.comparison)
    candidateConfig = { config_key: candidate.config_key, supported: ev.supported, reason: ev.reason, gate_passed: ev.supported && !!ev.comparison?.gate_passed }
  }
  return {
    ...(candidateConfig ? { candidate_config: candidateConfig } : {}),
    benchmark_version: BENCHMARK_VERSION,
    executed_at: now().toISOString(),
    data_kind: 'synthetic',
    notice: 'Dataset sintetici con etichette scritte a mano: misurano componenti deterministici, non la qualità commerciale reale né un modello AI.',
    contamination: checkContamination(),
    suites,
    comparisons,
    candidates: { sector: sectorCand, scoring: scoring.config, scoring_grid: scoring.grid },
  }
}
