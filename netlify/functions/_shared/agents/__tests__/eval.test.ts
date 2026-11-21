// @vitest-environment node
/**
 * Prompt 9 — AI Quality Evaluation e misure di prestazione del motore.
 * Dataset SINTETICI etichettati (eval/datasets), separati dai dati dei clienti. I risultati sono stampati
 * (npm run ai:eval) e NON vengono confrontati con soglie di "accuratezza elevata": il test verifica che le
 * metriche siano calcolate, che i controlli non diano falsi positivi sui casi puliti e che i difetti già
 * intercettati restino intercettati (regressione).
 * La valutazione "live" con un modello reale si esegue solo con AI_EVAL_LIVE=1 e credenziali OpenAI.
 */
import { describe, expect, it } from 'vitest'
import { defaultAiCaller } from '../../sales-agent/service'
import { jsonResponse } from '../../lead-finder/__tests__/fixtures'
import { evaluateScoring, evaluateStrategyLive, evaluateValidators } from '../eval/evaluate'
import { envForTask } from '../models'
import { runWorkflow } from '../engine'
import { planWorkflow, startWorkflow } from '../service'
import type { AgentStore } from '../store'
import { makeHarness, ORG_A } from './harness'

const report: Record<string, unknown> = {}

describe('AI Quality Evaluation (dataset sintetici)', () => {
  it('Scoring Agent: concordanza con etichette manuali', () => {
    const r = evaluateScoring()
    report.scoring = r
    expect(r.cases).toBe(20)
    const total = Object.values(r.confusion).reduce((a, row) => a + Object.values(row).reduce((x, y) => x + y, 0), 0)
    expect(total).toBe(r.cases)
    expect(r.agreement).toBe(Math.round(((r.cases - r.disagreements.length) / r.cases) * 1000) / 1000)
  })

  it('controlli dell\'output AI: difetti intercettati e falsi positivi', () => {
    const r = evaluateValidators()
    report.validators = r
    expect(r.defects_labeled).toBeGreaterThan(0)
    // I casi puliti non devono essere segnalati (un falso positivo bloccherebbe bozze corrette).
    expect(r.false_positive_cases).toEqual([])
    // Regressione: questi difetti sono intercettati oggi e devono continuare a esserlo.
    for (const f of ['schema_invalid', 'email_removed', 'unverified_fact', 'unverified_url', 'unverified_phone', 'unverified_amount']) {
      expect(r.by_flag[f]!.detected).toBe(r.by_flag[f]!.labeled)
    }
  })

  it('valutazione live: eseguita solo con credenziali reali (AI_EVAL_LIVE=1)', async () => {
    const live = process.env.AI_EVAL_LIVE === '1' && process.env.OPENAI_API_KEY
    const ai = live ? defaultAiCaller(envForTask('sales_strategy', null).env) : null
    const r = await evaluateStrategyLive(ai, { runs: Number(process.env.AI_EVAL_RUNS ?? 5) })
    report.live = r
    if (!live) expect(r).toMatchObject({ executed: false, reason: 'no_ai_credentials', json_valid_rate: null })
  }, 300_000)
})

/** Conta le chiamate allo store (≈ query al database in produzione: ogni metodo esegue ≥ 1 query). */
function countingStore(store: AgentStore) {
  const counts: Record<string, number> = {}
  const proxy = new Proxy(store, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        counts[String(prop)] = (counts[String(prop)] ?? 0) + 1
        return (v as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return { proxy, counts }
}

const SIM30 = { elements: Array.from({ length: 30 }, (_, i) => ({ type: 'node', id: 2000 + i, tags: { tourism: 'hotel', name: `Hotel Perf ${i + 1}`, 'addr:city': 'Roma', website: `https://perf-${i + 1}.example` } })) }

describe('Prestazioni del motore (in processo, servizi SIMULATI)', () => {
  it('avvio, durata, chiamate allo store e ai servizi per il workflow da 30 aziende', async () => {
    const h = makeHarness({ overpass: () => jsonResponse(SIM30) })
    const { proxy, counts } = countingStore(h.agents.store)
    const deps = { ...h.engineDeps, store: proxy }
    const objective = 'Trova 30 aziende nel settore alberghiero a Roma, analizzale, identifica le 10 più compatibili e prepara proposte commerciali personalizzate.'
    const t0 = performance.now()
    const planned = await planWorkflow({ ...h.serviceDeps, store: proxy }, h.ctxA, { objective })
    const started = await startWorkflow({ ...h.serviceDeps, store: proxy }, h.ctxA, { template: 'prospecting', params: planned.plan!.params, budget_credits: 50, idempotency_key: 'perf-30-0001', objective })
    const t1 = performance.now()
    await runWorkflow(deps, started.workflow_id)
    h.agents.rpc.decide(h.approvalFor(started.workflow_id)!.id, ORG_A, 'approve')
    const t2 = performance.now()
    const done = await runWorkflow(deps, started.workflow_id)
    const t3 = performance.now()
    expect(done.status).toBe('completed')
    const storeCalls = Object.values(counts).reduce((a, b) => a + b, 0)
    report.performance = {
      note: 'misurato in processo con store in memoria e servizi simulati: NON rappresenta la latenza di Supabase, OpenAI o Overpass',
      start_ms: Math.round(t1 - t0),
      run_until_approval_ms: Math.round(t2 - t1),
      run_after_approval_ms: Math.round(t3 - t2),
      store_calls_total: storeCalls,
      store_calls_by_method: counts,
      provider_http_calls: h.http.calls.length,
      ai_analyses: h.analyzeCalls.length,
      ai_strategy_calls: h.aiCalls.length,
      credits_used: h.workflow(started.workflow_id).creditsUsed,
    }
    // Un solo dispatch di ricerca verso il provider, nessuna chiamata AI duplicata.
    expect(h.http.calls.length).toBeLessThanOrEqual(2)
    expect(h.analyzeCalls.length).toBe(30)
    console.log(`\nAI_EVAL_REPORT ${JSON.stringify(report, null, 2)}`)
  })
})
