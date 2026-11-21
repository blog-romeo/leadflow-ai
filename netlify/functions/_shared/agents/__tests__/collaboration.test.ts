// @vitest-environment node
/**
 * Prompt 9 — Agent Collaboration Engine, routing dei modelli, resilienza.
 * Store in memoria e servizi SIMULATI (Overpass e OpenAI finti, dati etichettati come simulati):
 * verificano la logica, NON le integrazioni reali (vedi RELEASE_READINESS.md, REL-28).
 */
import { describe, expect, it } from 'vitest'
import { HttpError } from '../../http'
import { agentRunEnvelopeSchema, validateActionOutput } from '../envelope'
import { MAX_RETRY_DELAY_MS, retryDelayMs, runWorkflow } from '../engine'
import { HANDLERS } from '../handlers'
import { routeModel, TASK_ROUTES } from '../models'
import { parseObjective } from '../planner'
import { planWorkflow, startWorkflow } from '../service'
import { jsonResponse } from '../../lead-finder/__tests__/fixtures'
import { makeHarness, prospecting, ORG_A, ORG_B, USER_A } from './harness'

/** 30 strutture ricettive SIMULATE (nessun dato reale): nomi e domini .example. */
const SIMULATED_HOTELS_30 = {
  elements: Array.from({ length: 30 }, (_, i) => ({
    type: 'node',
    id: 1000 + i,
    tags: {
      tourism: 'hotel',
      name: `Hotel Simulato ${i + 1}`,
      'addr:city': 'Roma',
      ...(i % 3 !== 2 ? { website: `https://hotel-simulato-${i + 1}.example` } : {}),
      ...(i % 2 === 0 ? { phone: `+39 06 ${String(5550000 + i)}` } : {}),
    },
  })),
}

const OBJECTIVE = 'Trova 30 aziende nel settore alberghiero a Roma, analizzale, identifica le 10 più compatibili e prepara proposte commerciali personalizzate.'

describe('Workflow reale (simulato) del Prompt 9: 30 hotel a Roma → 10 proposte', () => {
  it('interpretazione → piano → esecuzione → approvazione → strategie, con envelope validati', async () => {
    const parsed = parseObjective(OBJECTIVE)
    expect(parsed.template).toBe('prospecting')
    expect(parsed.params).toMatchObject({ sector: 'hotel', location: 'Roma', max_results: 30, analyze_top: 30, proposals_top: 10 })

    const h = makeHarness({ overpass: () => jsonResponse(SIMULATED_HOTELS_30) })
    const planned = await planWorkflow(h.serviceDeps, h.ctxA, { objective: OBJECTIVE })
    expect(planned.plan!.blocked).toBe(false)
    // Stima massima dichiarata: 30 analisi × 1 + 10 strategie × 2 = 50 crediti.
    expect(planned.plan!.estimate.max_credits).toBe(50)
    expect(planned.plan!.approvals).toEqual(['crm.save_leads'])

    const started = await startWorkflow(h.serviceDeps, h.ctxA, { template: 'prospecting', params: planned.plan!.params, budget_credits: 50, idempotency_key: 'p9-e2e-1', objective: OBJECTIVE })
    expect((await runWorkflow(h.engineDeps, started.workflow_id)).status).toBe('waiting_approval')
    const [s1, s2, s3] = h.steps(started.workflow_id)
    expect(s1!.output!.counts).toMatchObject({ found: 30, kept: 30 })
    expect(s2!.output!.counts).toMatchObject({ total: 30, analyzed: 30, failed: 0 })
    expect((s3!.output!.ranked as unknown[]).length).toBe(30)
    // Nessun lead nel CRM prima dell'approvazione.
    expect(h.lf.state.leads).toHaveLength(0)
    const approval = h.approvalFor(started.workflow_id)!
    expect(approval.summary.count).toBeLessThanOrEqual(10)

    h.agents.rpc.decide(approval.id, ORG_A, 'approve')
    expect((await runWorkflow(h.engineDeps, started.workflow_id)).status).toBe('completed')
    const wf = h.workflow(started.workflow_id)
    const strategies = h.steps(started.workflow_id)[4]!.output!.strategies as unknown[]
    expect(strategies.length).toBe(approval.summary.count)
    expect(wf.creditsUsed).toBeLessThanOrEqual(50)
    expect(h.steps(started.workflow_id)[4]!.output!.no_messages_sent).toBe(true)

    // Ogni esecuzione conclusa ha un envelope JSON valido con identificativi, uso e durata.
    const runs = h.agents.state.runs.filter((r) => r.workflowId === started.workflow_id && r.status === 'succeeded')
    expect(runs.length).toBe(5)
    for (const r of runs) {
      const env = agentRunEnvelopeSchema.parse(r.output)
      expect(env.workflow_id).toBe(started.workflow_id)
      expect(env.organization_id).toBe(ORG_A)
      expect(env.output_valid).toBe(true)
      expect(env.errors.some((e) => e.code === 'envelope_invalid')).toBe(false)
    }
    const byAction = Object.fromEntries(runs.map((r) => { const e = agentRunEnvelopeSchema.parse(r.output); return [e.action, e] }))
    expect(byAction.research!.evidence).toMatchObject({ required: true, items_total: 30 })
    expect(byAction.research!.evidence.facts).toBeGreaterThan(0)
    expect(byAction.research!.usage.credits).toBe(30)
    expect(byAction.strategy!.usage.credits).toBe(2 * strategies.length)
    // AI_ENV dei test configura solo OPENAI_MODEL: la strategia ricade (ammesso) sul livello standard.
    expect(byAction.strategy!.routing).toMatchObject({ tier: 'standard', fallback: true })
    expect(byAction.score!.usage.credits).toBe(0)
  })

  it('senza credenziali del provider: piano bloccato e nessuna ricerca simulata come reale', async () => {
    const h = makeHarness({ env: { OVERPASS_API_URL: '', OVERPASS_CONTACT: '' } })
    const planned = await planWorkflow(h.serviceDeps, h.ctxA, { objective: OBJECTIVE })
    expect(planned.plan!.blocked).toBe(true)
    expect(planned.plan!.missing.map((m) => m.code)).toContain('provider_not_configured')
    await expect(startWorkflow(h.serviceDeps, h.ctxA, { template: 'prospecting', params: planned.plan!.params, budget_credits: 50, idempotency_key: 'p9-noprov', objective: OBJECTIVE })).rejects.toMatchObject({ status: 409, code: 'plan_blocked' })
    expect(h.http.calls).toHaveLength(0)
    expect(h.agents.state.workflows).toHaveLength(0)
  })
})

describe('Contratto tra agenti (output JSON validato)', () => {
  it('output non conforme: passo fallito senza retry, dipendenti saltati, nessun credito', async () => {
    const h = makeHarness()
    const deps = { ...h.engineDeps, handlers: { ...HANDLERS, score: { agent: 'scoring' as const, run: async () => ({ output: { ranked: 'testo libero' }, itemsTotal: 1, itemsFailed: 0 }) } } }
    const { workflow_id } = await h.start('prospecting', prospecting({ analyze_top: 0 }))
    const r = await runWorkflow(deps, workflow_id)
    expect(r.status).toBe('partial')
    const steps = h.steps(workflow_id)
    const score = steps.find((s) => s.action === 'score')!
    expect([score.status, score.errorCode, score.attempts]).toEqual(['failed', 'invalid_agent_output', 1])
    expect(steps.find((s) => s.action === 'crm.save_leads')!.errorCode).toBe('dependency_not_completed')
    const run = h.agents.state.runs.find((x) => x.stepId === score.id)!
    expect(run.errorCode).toBe('invalid_agent_output')
    expect((run.output as Record<string, unknown>).output_valid).toBe(false)
    expect(h.workflow(workflow_id).creditsUsed).toBe(0)
  })

  it('schemi per azione: campi richiesti dagli agenti successivi', () => {
    expect(validateActionOutput('discover', { done: true, provider: 'x', search_id: 's', candidate_ids: ['nope'], counts: { total: 1, found: 1, new: 1, kept: 1 } }).ok).toBe(false)
    expect(validateActionOutput('strategy', { strategies: [], counts: { total: 0, generated: 0, cached: 0, failed: 0 }, no_messages_sent: false }).ok).toBe(false)
    expect(validateActionOutput('strategy', { strategies: [], counts: { total: 0, generated: 0, cached: 0, failed: 0 }, no_messages_sent: true }).ok).toBe(true)
  })

  it('isolamento: gli envelope di un\'organizzazione portano solo il suo identificativo', async () => {
    const h = makeHarness()
    const a = await h.start('prospecting', prospecting({ proposals_top: 0 }))
    const b = await h.start('prospecting', prospecting({ proposals_top: 0 }), 100, 'key-b', { orgId: ORG_B, userId: USER_A, isAdmin: true })
    await runWorkflow(h.engineDeps, a.workflow_id)
    await runWorkflow(h.engineDeps, b.workflow_id)
    for (const r of h.agents.state.runs) {
      const env = agentRunEnvelopeSchema.parse(r.output)
      expect(env.organization_id).toBe(r.org)
      expect(env.workflow_id).toBe(r.workflowId)
    }
    expect(h.agents.state.runs.some((r) => r.org === ORG_B)).toBe(true)
  })
})

describe('Intelligent Agent Routing', () => {
  const ENV = { OPENAI_MODEL: 'std-model', OPENAI_MODEL_ECONOMY: 'eco-model', OPENAI_MODEL_ADVANCED: 'adv-model' }
  it('modello per compito', () => {
    expect(routeModel('classification', null, ENV)).toMatchObject({ effective: 'economy', model: 'eco-model', fallback: false })
    expect(routeModel('summary', null, ENV).effective).toBe('economy')
    expect(routeModel('company_analysis', null, ENV).effective).toBe('economy')
    expect(routeModel('sales_strategy', null, ENV)).toMatchObject({ effective: 'advanced', model: 'adv-model' })
  })
  it('la configurazione dell\'organizzazione non scende sotto il minimo del compito', () => {
    expect(routeModel('sales_strategy', 'economy', ENV)).toMatchObject({ requested: 'standard', effective: 'standard', reason: 'raised_to_minimum' })
    expect(routeModel('company_analysis', 'advanced', ENV)).toMatchObject({ effective: 'advanced', reason: 'org_config' })
  })
  it('fallback solo verso livelli ammessi e solo se il modello manca', () => {
    expect(routeModel('sales_strategy', null, { OPENAI_MODEL: 'std-model', OPENAI_MODEL_ECONOMY: 'eco-model' })).toMatchObject({ effective: 'standard', fallback: true })
    // La strategia non ricade mai sul modello economico.
    expect(routeModel('sales_strategy', null, { OPENAI_MODEL_ECONOMY: 'eco-model' })).toMatchObject({ model: null, reason: 'not_configured' })
    expect(routeModel('classification', null, { OPENAI_MODEL: 'std-model' })).toMatchObject({ effective: 'standard', fallback: true })
    for (const r of Object.values(TASK_ROUTES)) expect(r.fallbacks.every((t) => ['economy', 'standard', 'advanced'].indexOf(t) >= ['economy', 'standard', 'advanced'].indexOf(r.minimum))).toBe(true)
  })
  it('override di piattaforma (server-side) soggetto al minimo', () => {
    expect(routeModel('summary', null, { ...ENV, AI_ROUTE_SUMMARY: 'standard' })).toMatchObject({ effective: 'standard', reason: 'platform_override' })
    expect(routeModel('sales_strategy', null, { ...ENV, AI_ROUTE_SALES_STRATEGY: 'economy' })).toMatchObject({ effective: 'standard', reason: 'raised_to_minimum' })
    expect(routeModel('summary', null, { ...ENV, AI_ROUTE_SUMMARY: 'gpt-qualsiasi' }).reason).toBe('preferred')
  })
})

describe('Resilienza', () => {
  it('backoff esponenziale con jitter e Retry-After, con tetto', () => {
    expect(retryDelayMs(1, undefined, () => 0)).toBe(500)
    expect(retryDelayMs(1, undefined, () => 1)).toBe(1000)
    expect(retryDelayMs(3, undefined, () => 1)).toBe(4000)
    expect(retryDelayMs(1, { retry_after: 20 }, () => 0)).toBe(20_000)
    expect(retryDelayMs(1, { retry_after: 3600 }, () => 0)).toBe(MAX_RETRY_DELAY_MS)
    expect(retryDelayMs(1, { retry_after: -5 }, () => 0)).toBe(500)
  })

  it('esecuzioni concorrenti: limite di workflow attivi per organizzazione, replay idempotente ammesso', async () => {
    const h = makeHarness({ agent: { maxActiveWorkflows: 1 } })
    const first = await h.start('prospecting', prospecting(), 100, 'same-key')
    await expect(h.start('prospecting', prospecting(), 100, 'other-key')).rejects.toBeInstanceOf(HttpError)
    await expect(h.start('prospecting', prospecting(), 100, 'other-key')).rejects.toMatchObject({ status: 409, code: 'too_many_active_workflows' })
    // Stessa chiave: stesso workflow, nessun errore e nessun nuovo avvio.
    const replay = await h.start('prospecting', prospecting(), 100, 'same-key')
    expect([replay.workflow_id, replay.created]).toEqual([first.workflow_id, false])
    // Un'altra organizzazione non è influenzata.
    await expect(h.start('prospecting', prospecting(), 100, 'b-key', { orgId: ORG_B, userId: USER_A, isAdmin: true })).resolves.toMatchObject({ created: true })
  })

  it('errore permanente del provider: nessun retry automatico (nessun doppio consumo)', async () => {
    let calls = 0
    const h = makeHarness({ overpass: () => { calls++; return new Response('bad request', { status: 400 }) } })
    const { workflow_id } = await h.start('prospecting', prospecting({ analyze_top: 0, proposals_top: 2 }))
    const r = await runWorkflow(h.engineDeps, workflow_id)
    const steps = h.steps(workflow_id)
    expect(steps[0]!.attempts).toBe(1)
    expect(calls).toBeLessThanOrEqual(1)
    // Regressione (difetto trovato nel Prompt 9): una catena di passi dipendenti viene saltata per intero,
    // senza chiudere il workflow come 'dependency_deadlock'.
    expect(steps.slice(1).map((s) => [s.status, s.errorCode])).toEqual([['skipped', 'dependency_not_completed'], ['skipped', 'dependency_not_completed'], ['skipped', 'dependency_not_completed']])
    expect(r.status).toBe('failed')
    expect(h.workflow(workflow_id).errorCode).not.toBe('dependency_deadlock')
  })
})
