// @vitest-environment node
/**
 * Prompt 12 — Quality Reviewer, benchmark ripetibili e gate di promozione.
 * Dataset SINTETICI (training/datasets). `npm run ai:benchmark` scrive anche il report JSON se è impostata
 * BENCHMARK_REPORT_PATH. I numeri NON sono confrontati con soglie di "alta accuratezza": si verificano
 * l'assenza di contaminazione, la ripetibilità, la coerenza delle metriche e le regole del gate.
 */
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AGENTS, isForbiddenTool } from '../catalog'
import { reviewStep } from '../reviewer'
import { BASELINE, checkContamination, evaluateCandidate, macro, prf, runBenchmark, runReviewSuite, runScoringSuite } from '../training/benchmark'
import { DATASETS } from '../training/catalog'
import { runWorkflow } from '../engine'
import { makeHarness, prospecting, ORG_A } from './harness'

describe('Quality Reviewer', () => {
  const L = '00000000-0000-4000-8000-00000000000'
  it('rileva duplicati, contraddizioni, fatti senza fonte e strategie non supportate', () => {
    const strategies = [1, 1, 2].map((n) => ({ lead_id: `${L}${n}`, status: 'generated', warnings: [], strategy: { opportunity: { statement: 'x y z', basis: 'fact', evidence: n === 2 ? '' : 'e' }, value_proposition: 'v', approach: { steps: ['a'] }, missing_information: [] } }))
    const r = reviewStep('strategy', { strategies }, { research: { results: { c1: 'failed' } }, leadToCandidate: { [`${L}1`]: 'c1' } })
    const codes = r.findings.map((f) => f.code)
    expect(codes).toEqual(expect.arrayContaining(['duplicate_ids', 'unsourced_fact', 'strategy_unsupported']))
    expect(r.blocking.map((b) => b.code)).toContain('duplicate_ids')
    expect(reviewStep('score', { ranked: [{ candidate_id: 'a', score: 40, priority: 'high', basis: 'rules', evidence: [] }] }).blocking[0]!.code).toBe('contradiction')
  })
  it('nel motore: avvisi salvati nell\'output e nell\'envelope; i blocchi fermano il passo senza retry', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting())
    await runWorkflow(h.engineDeps, workflow_id)
    h.agents.rpc.decide(h.approvalFor(workflow_id)!.id, ORG_A, 'approve')
    await runWorkflow(h.engineDeps, workflow_id)
    const strategy = h.steps(workflow_id).find((s) => s.action === 'strategy')!
    const review = strategy.output!.review as { checked: number; findings: Record<string, number> }
    expect(review.checked).toBe(2)
    // I mock restituiscono la stessa strategia per ogni lead: il Reviewer segnala l'assenza di personalizzazione.
    expect(review.findings.duplicate_content).toBe(1)
    const run = h.agents.state.runs.find((r) => r.stepId === strategy.id)!
    expect((run.output as { review: unknown }).review).toMatchObject({ checked: 2, blocking: 0 })

    // Configurazione approvata che blocca anche duplicate_content → il passo si ferma.
    const h2 = makeHarness()
    const w2 = await h2.start('prospecting', prospecting())
    const deps = { ...h2.engineDeps, reviewerBlocking: ['duplicate_ids', 'contradiction', 'duplicate_content'] as const }
    await runWorkflow(deps, w2.workflow_id)
    h2.agents.rpc.decide(h2.approvalFor(w2.workflow_id)!.id, ORG_A, 'approve')
    await runWorkflow(deps, w2.workflow_id)
    const s2 = h2.steps(w2.workflow_id).find((s) => s.action === 'strategy')!
    expect([s2.status, s2.errorCode, s2.attempts]).toEqual(['failed', 'review_blocked', 1])
  })
})

describe('Benchmark engine', () => {
  it('metriche: P/R/F1 e macro su casi noti', () => {
    expect(prf(8, 2, 2)).toEqual({ precision: 0.8, recall: 0.8, f1: 0.8, support: 10 })
    expect(prf(0, 0, 0)).toMatchObject({ precision: null, recall: null, f1: null })
    expect(macro([{ expected: 'a', got: 'a' }, { expected: 'b', got: 'a' }, { expected: null, got: null }]).accuracy).toBe(0.667)
  })
  it('dataset versionati, sintetici e senza contaminazione tra split', () => {
    for (const d of DATASETS) expect(d.synthetic).toBe(true)
    for (const c of checkContamination()) expect([c.dataset, c.duplicate_ids, c.duplicate_inputs]).toEqual([c.dataset, [], []])
  })
  it('candidati derivati senza usare il test set e confronto sullo stesso test indipendente', async () => {
    const a = await runBenchmark(() => new Date('2026-11-21T00:00:00Z'))
    const b = await runBenchmark(() => new Date('2026-11-21T00:00:00Z'))
    // Ripetibile: stessi risultati (latenze escluse).
    const strip = (r: typeof a) => JSON.stringify(r.suites.map((s) => ({ ...s, ms: 0 })))
    expect(strip(a)).toBe(strip(b))
    expect(a.data_kind).toBe('synthetic')
    expect(a.comparisons.every((c) => c.split === 'test')).toBe(true)
    expect(a.suites.find((s) => s.suite === 'llm_strategy')).toMatchObject({ status: 'not_executed', reason: 'requires_authorized_model_access' })
    // Il Quality Reviewer non segnala output corretti (nessun falso positivo sul test set).
    expect(runReviewSuite('test', { label: 'c', reviewer: true }).metrics.clean_cases_flagged).toEqual([])
    expect(runScoringSuite('test', BASELINE.scoring).metrics.score_is_probability).toBe(false)
    if (process.env.BENCHMARK_REPORT_PATH) writeFileSync(process.env.BENCHMARK_REPORT_PATH, JSON.stringify(a, null, 2))
  })
  it('gate: si promuove solo senza regressioni; configurazioni non valutabili non passano', () => {
    const base = { blocking_codes: ['duplicate_ids', 'contradiction'] }
    expect(evaluateCandidate({ config_key: 'quality_reviewer.blocking_codes', config: { blocking_codes: ['duplicate_ids'] }, baseline_config: base }).comparison!.gate_passed).toBe(false)
    expect(evaluateCandidate({ config_key: 'quality_reviewer.blocking_codes', config: { blocking_codes: ['duplicate_ids', 'contradiction', 'unsourced_fact'] }, baseline_config: base }).comparison!.gate_passed).toBe(true)
    expect(evaluateCandidate({ config_key: 'strategy.prompt', config: {}, baseline_config: null })).toMatchObject({ supported: false, reason: 'no_benchmark_for_config_key' })
  })
})

describe('Hardening degli agenti (Prompt 12)', () => {
  it('nessun agente può toccare pagamenti, ruoli, credenziali, sicurezza, configurazioni o il proprio training', () => {
    for (const tool of ['billing.update', 'stripe.refund', 'roles.grant', 'members.add', 'secrets.read', 'credentials.rotate', 'security.disable', 'settings.update', 'feature_flags.enable', 'ai_config.activate', 'configs.write', 'training.promote', 'benchmarks.write', 'feedback.validate', 'agents.configure', 'emails.send', 'campaigns.launch']) {
      expect(isForbiddenTool(tool)).toBe(true)
    }
    for (const a of Object.values(AGENTS)) for (const t of a.tools) expect(isForbiddenTool(t)).toBe(false)
  })
})
