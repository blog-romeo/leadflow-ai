// @vitest-environment node
/** Planner, Follow-up Agent, Growth Analyst, modelli e costi, ricalcolo punteggio (dati simulati). */
import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../engine'
import { buildPlan, parseObjective, validateParams, type Availability } from '../planner'
import { chooseModel, estimateTierCost } from '../models'
import { growthInsights, twoProportionZ, MIN_SECTOR_LEADS } from '../handlers/growth'
import { agentScore, rescore } from '../handlers/scoring'
import { BudgetTracker } from '../budget'
import { hotelProfile } from '../../lead-finder/__tests__/fixtures'
import { makeHarness, ORG_A, USER_A } from './harness'
import { emptyMetrics } from './memoryAgentStore'

const availability = (over: Partial<Availability> = {}): Availability => ({
  providers: [{ id: 'osm_overpass', configured: true, canStore: true, missing: [] }, { id: 'google_places', configured: true, canStore: false, missing: [] }],
  ai: { configured: true, missing: [] },
  features: { lead_finder: true, ai_analyzer: true, ai_sales_agent: true, crm_advanced: true },
  agents: [],
  creditCosts: { business_analysis: 1, sales_strategy: 2, follow_up_suggestion: 1 },
  salesProfileMissing: [],
  ...over,
})

describe('Planner deterministico', () => {
  it('interpreta l’esempio del prompt', () => {
    const r = parseObjective('Trova 30 aziende nel settore alberghiero a Roma, analizzale e prepara una proposta commerciale per le 10 più compatibili.')
    expect(r.template).toBe('prospecting')
    expect(r.params).toMatchObject({ max_results: 30, analyze_top: 30, proposals_top: 10, sector: 'hotel', location: 'Roma', country: 'IT' })
    const v = validateParams('prospecting', r.params)
    expect(v.ok).toBe(true)
    const plan = buildPlan('prospecting', (v as { params: Record<string, unknown> }).params, availability())
    expect(plan.steps.map((s) => `${s.position}:${s.agentKey}:${s.action}`)).toEqual(['1:discovery:discover', '2:research:research', '3:scoring:score', '4:orchestrator:crm.save_leads', '5:strategy:strategy'])
    expect(plan.approvals).toEqual(['crm.save_leads'])
    expect(plan.estimate.max_credits).toBe(30 * 1 + 10 * 2)
    expect(plan.blocked).toBe(false)
  })

  it('limiti applicati e segnalati', () => {
    const r = parseObjective('Trova 500 ristoranti a Milano e prepara proposte per i 50 migliori')
    expect(r.params.max_results).toBe(50)
    expect(r.params.proposals_top).toBe(20)
    expect(r.warnings).toEqual(expect.arrayContaining(['max_results_capped', 'proposals_top_capped']))
  })

  it('riconosce follow-up e analisi delle prestazioni', () => {
    expect(parseObjective('Controlla le trattative ferme e prepara i follow-up').template).toBe('follow_up_review')
    expect(parseObjective('Analizza le prestazioni commerciali degli ultimi 60 giorni')).toMatchObject({ template: 'growth_report', params: { period_days: 60 } })
  })

  it('configurazioni mancanti, funzionalità non incluse, profilo incompleto: piano bloccato con dettagli', () => {
    const plan = buildPlan('prospecting', validateParams('prospecting', { sector: 'hotel', location: 'Roma', proposals_top: 3 }).ok ? (validateParams('prospecting', { sector: 'hotel', location: 'Roma', proposals_top: 3 }) as { params: Record<string, unknown> }).params : {}, availability({
      providers: [{ id: 'osm_overpass', configured: false, canStore: true, missing: ['OVERPASS_API_URL', 'OVERPASS_CONTACT'] }, { id: 'google_places', configured: true, canStore: false, missing: [] }],
      ai: { configured: false, missing: ['OPENAI_API_KEY'] },
      features: { lead_finder: true, ai_analyzer: true, ai_sales_agent: false, crm_advanced: false },
      salesProfileMissing: ['services'],
    }))
    expect(plan.blocked).toBe(true)
    const codes = plan.missing.map((m) => `${m.component}:${m.code}`)
    expect(codes).toEqual(expect.arrayContaining(['discovery:provider_not_configured', 'research:ai_not_configured', 'strategy:billing_feature_not_in_plan', 'strategy:sales_profile_incomplete']))
    // Google Places non sostituisce Overpass: la licenza non consente la memorizzazione.
    expect(plan.missing.find((m) => m.code === 'provider_not_configured')!.env).toEqual(['OVERPASS_API_URL', 'OVERPASS_CONTACT'])
  })

  it('parametri non validi rifiutati', () => {
    expect(validateParams('prospecting', { sector: 'h', location: 'Roma' }).ok).toBe(false)
    expect(validateParams('prospecting', { sector: 'hotel', location: 'Roma', max_results: 10, analyze_top: 20 }).ok).toBe(false)
    expect(validateParams('prospecting', { sector: 'hotel', location: 'Roma', provider: 'google_places' }).ok).toBe(false)
    expect(validateParams('growth_report', { period_days: 1000 }).ok).toBe(false)
    expect(validateParams('follow_up_review', { unknown: true }).ok).toBe(false)
  })
})

describe('AI Follow-up Agent', () => {
  const LEAD_STALE = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'
  const LEAD_OPTED = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02'
  const LEAD_FRESH = 'dddddddd-dddd-4ddd-8ddd-dddddddddd03'
  const LEAD_PLANNED = 'dddddddd-dddd-4ddd-8ddd-dddddddddd04'
  const snapshot = {
    leads: [
      { id: LEAD_STALE, company_name: 'Hotel Fermo', status: 'contacted', contactable: true, days_since_activity: 30, open_tasks: [] },
      { id: LEAD_OPTED, company_name: 'Hotel Opposto', status: 'not_contactable', contactable: false, days_since_activity: 40, open_tasks: [{ id: 'task-opted', kind: 'check_in', is_contact: true, due_at: '2026-11-01T00:00:00Z', title: 'Chiamare' }] },
      { id: LEAD_FRESH, company_name: 'Hotel Attivo', status: 'in_conversation', contactable: true, days_since_activity: 2, open_tasks: [] },
      { id: LEAD_PLANNED, company_name: 'Hotel Pianificato', status: 'proposal_sent', contactable: true, days_since_activity: 20, open_tasks: [{ id: 't2', kind: 'second_contact', is_contact: true, due_at: '2026-11-25T00:00:00Z', title: 'x' }] },
    ],
    overdue_tasks: [{ id: 'task-opted', lead_id: LEAD_OPTED, title: 'Chiamare', due_at: '2026-11-01T00:00:00Z', kind: 'check_in' }],
    stale_opportunities: [{ id: 'opp-1', lead_id: LEAD_OPTED, title: 'Sito nuovo', days_since_update: 45, lead_contactable: false }],
  }

  it('analizza, chiede approvazione, crea promemoria interni e blocca i contatti verso chi si è opposto', async () => {
    const h = makeHarness({ agent: { followUp: { [ORG_A]: snapshot }, notContactableLeads: new Set([LEAD_OPTED]) } })
    h.agents.state.followUpTasks.push({ id: 'task-opted', org: ORG_A, leadId: LEAD_OPTED, kind: 'check_in', status: 'open', title: 'Chiamare', source: 'manual' })
    const { workflow_id } = await h.start('follow_up_review', {}, 10)
    expect((await runWorkflow(h.engineDeps, workflow_id)).status).toBe('waiting_approval')
    const analysis = h.steps(workflow_id)[0]!.output!
    expect(analysis.counts).toMatchObject({ to_create: 2, to_block: 1, skipped_not_contactable: 1, already_planned: 1, overdue: 1 })
    const create = (analysis.proposal as { create: { leadId: string; kind: string }[] }).create
    // Nessun contatto verso chi si è opposto; solo la revisione interna dell'opportunità.
    expect(create.filter((c) => c.leadId === LEAD_OPTED).map((c) => c.kind)).toEqual(['opportunity_review'])
    expect(create.find((c) => c.leadId === LEAD_STALE)!.kind).toBe('check_in')
    expect(h.agents.state.followUpTasks).toHaveLength(1)

    h.agents.rpc.decide(h.approvalFor(workflow_id)!.id, ORG_A, 'approve')
    expect((await runWorkflow(h.engineDeps, workflow_id)).status).toBe('completed')
    expect(h.agents.state.followUpTasks.find((t) => t.id === 'task-opted')!.status).toBe('blocked')
    const created = h.agents.state.followUpTasks.filter((t) => t.source === 'ai')
    expect(created.map((t) => [t.leadId, t.kind]).sort()).toEqual([[LEAD_STALE, 'check_in'], [LEAD_OPTED, 'opportunity_review']].sort())
    expect(h.agents.state.audit.some((a) => a.action === 'ai_agent.follow_up_applied')).toBe(true)
  })

  it('bozze facoltative: generate con il Sales Agent, mai inviate, crediti contati', async () => {
    const h = makeHarness({ agent: { followUp: { [ORG_A]: snapshot } } })
    h.sales.state.leads[LEAD_STALE] = { org: ORG_A, ...(await import('../../sales-agent/__tests__/fixtures')).leadRaw({ id: LEAD_STALE, company_name: 'Hotel Fermo', status: 'contacted' }) }
    // I promemoria creati dall'agente sono visibili al Sales Agent come follow_up_tasks.
    h.agents.store.createFollowUpTasks = async (_org, rows) => {
      const ids = rows.map((r, i) => {
        const id = `eeeeeeee-eeee-4eee-8eee-00000000000${i}`
        h.sales.state.tasks.push({ id, org: ORG_A, lead_id: r.leadId, kind: r.kind, title: r.title, notes: r.notes, due_at: r.dueAt, status: 'open' })
        return id
      })
      return { created: ids, skipped: 0 }
    }
    h.engineDeps.services.ai = async () => ({ json: { suggestion: 'Richiamare', reasoning: 'Nessuna risposta da 30 giorni', timing_note: 'In mattinata', message: { subject: 'Un saluto', body: 'Buongiorno, la ricontatto per sapere se...' } }, model: 'm', usage: { input_tokens: 100, output_tokens: 50 } })
    const { workflow_id } = await h.start('follow_up_review', { prepare_drafts: true, drafts_max: 3 }, 10)
    await runWorkflow(h.engineDeps, workflow_id)
    expect(h.approvalFor(workflow_id)!.summary).toMatchObject({ drafts: 1, estimated_credits: 1 })
    h.agents.rpc.decide(h.approvalFor(workflow_id)!.id, ORG_A, 'approve')
    expect((await runWorkflow(h.engineDeps, workflow_id)).status).toBe('completed')
    expect(h.sales.state.drafts.filter((d) => d.channel === 'follow_up')).toHaveLength(1)
    expect(h.workflow(workflow_id).creditsUsed).toBe(1)
    expect(h.steps(workflow_id)[1]!.output!.no_messages_sent).toBe(true)
  })

  it('niente da fare: il passo di approvazione viene saltato senza richiesta', async () => {
    const h = makeHarness({ agent: { followUp: { [ORG_A]: { leads: [], overdue_tasks: [], stale_opportunities: [] } } } })
    const { workflow_id } = await h.start('follow_up_review', {}, 0)
    expect((await runWorkflow(h.engineDeps, workflow_id)).status).toBe('completed')
    expect(h.agents.state.approvals).toHaveLength(0)
  })
})

describe('AI Growth Analyst', () => {
  it('dati insufficienti: nessuna affermazione comparativa', () => {
    const cur = emptyMetrics({ leads_acquired: 12, by_sector: [{ sector: 'hotel', leads: 8, contacted: 8, with_appointment: 6, won: 1 }, { sector: 'ristorante', leads: 4, contacted: 4, with_appointment: 0, won: 0 }] })
    const r = growthInsights(cur, null)
    expect(r.insights.filter((i) => i.code === 'sector_higher_appointment_rate')).toEqual([])
    expect(r.data_gaps).toEqual(expect.arrayContaining(['insufficient_data_sector_comparison', 'costs_not_configured']))
  })

  it('differenza significativa con campioni sufficienti: affermazione con numeri e test', () => {
    const cur = emptyMetrics({
      leads_acquired: 120, leads_contactable: 100, leads_contacted: 80, responses: 20, cost_per_lead_usd: 0.4,
      by_sector: [{ sector: 'hotel', leads: 60, contacted: 50, with_appointment: 18, won: 3 }, { sector: 'ristorante', leads: 60, contacted: 30, with_appointment: 4, won: 0 }],
    })
    const r = growthInsights(cur, emptyMetrics({ leads_acquired: 60 }))
    const s = r.insights.find((i) => i.code === 'sector_higher_appointment_rate')!
    expect(s.params).toMatchObject({ sector: 'hotel', rate: 30, n: 60, rest_rate: 6.7, rest_n: 60 })
    expect(s.test!.p_value).toBeLessThan(0.05)
    expect(r.insights.map((i) => i.code)).toEqual(expect.arrayContaining(['response_rate', 'lead_volume_increase']))
    expect(r.data_gaps).not.toContain('costs_not_configured')
  })

  it('differenza non significativa: nessuna affermazione', () => {
    const cur = emptyMetrics({ leads_acquired: 70, by_sector: [{ sector: 'hotel', leads: MIN_SECTOR_LEADS + 5, contacted: 30, with_appointment: 6, won: 0 }, { sector: 'b&b', leads: 35, contacted: 30, with_appointment: 5, won: 0 }] })
    expect(growthInsights(cur, null).insights.filter((i) => i.code === 'sector_higher_appointment_rate')).toEqual([])
  })

  it('z-test su due proporzioni', () => {
    const t = twoProportionZ(18, 60, 4, 60)!
    expect(t.z).toBeGreaterThan(3)
    expect(t.p).toBeLessThan(0.01)
    expect(twoProportionZ(0, 0, 1, 1)).toBeNull()
  })

  it('workflow growth_report: nessun credito AI, metriche del periodo e del precedente', async () => {
    const h = makeHarness({ agent: { metrics: { [ORG_A]: emptyMetrics({ leads_acquired: 5 }) } } })
    const { workflow_id } = await h.start('growth_report', { period_days: 30 }, 0)
    expect((await runWorkflow(h.engineDeps, workflow_id)).status).toBe('completed')
    const out = h.steps(workflow_id)[0]!.output!
    expect(out.metrics).toMatchObject({ leads_acquired: 5 })
    expect(out.data_gaps).toContain('insufficient_data_sector_comparison')
    expect(h.workflow(workflow_id).creditsUsed).toBe(0)
  })
})

describe('AI Cost Optimization: modelli e prezzi configurabili', () => {
  it('livelli con ripiego sul modello standard, nessun nome di modello nel codice', () => {
    expect(chooseModel('economy', { OPENAI_MODEL: 'std' })).toMatchObject({ model: 'std', effective: 'standard', fallback: true })
    expect(chooseModel('economy', { OPENAI_MODEL: 'std', OPENAI_MODEL_ECONOMY: 'eco' })).toMatchObject({ model: 'eco', effective: 'economy', fallback: false })
    expect(chooseModel('advanced', {})).toMatchObject({ model: null })
  })

  it('costo nullo se il prezzo non è configurato (nessun prezzo inventato)', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 }
    expect(estimateTierCost(usage, 'standard', {})).toBeNull()
    expect(estimateTierCost(usage, 'economy', { OPENAI_PRICE_INPUT_PER_MTOK: '2', OPENAI_PRICE_OUTPUT_PER_MTOK: '8' })).toBeNull()
    expect(estimateTierCost(usage, 'economy', { OPENAI_PRICE_INPUT_PER_MTOK_ECONOMY: '0.5', OPENAI_PRICE_OUTPUT_PER_MTOK_ECONOMY: '1' })).toBe(1.5)
  })

  it('budget: limiti di workflow, organizzazione, agente ed esecuzione', () => {
    const b = new BudgetTracker({ workflowBudget: 10, workflowUsed: 0, orgMonthlyBudget: 100, orgMonthlyUsed: 95, agentMonthly: { research: { budget: 3, used: 0 } }, perRunMax: { strategy: 2 } })
    expect(b.check('research', 4)).toBe('agent_budget_exceeded')
    expect(b.check('strategy', 6)).toBe('org_agent_budget_exceeded')
    b.reserve('strategy', 2)
    expect(b.check('strategy', 1)).toBe('run_budget_exceeded')
    b.refund('strategy', 2)
    expect(b.workflowUsed).toBe(0)
    expect(b.check('scoring', 11)).toBe('workflow_budget_exceeded')
  })
})

describe('AI Lead Scoring Agent', () => {
  const company = { companyName: 'Hotel Aurora', sector: 'hotel', categoryTags: [], address: 'Via Roma 1', city: 'Roma', region: null, country: 'IT', website: 'https://a.example', phone: '+39 06 1' }

  it('lo storico commerciale conta solo con un campione minimo', () => {
    const base = agentScore(company, hotelProfile, null, { history: null, historyWeight: 0, minSample: 10, inCrm: false, excluded: false })
    expect(base.history).toMatchObject({ applied: false, reason: 'history_disabled' })
    expect(base.measure).toBe('compatibility_index')
    const small = agentScore(company, hotelProfile, null, { history: { hotel: { won: 3, lost: 1 } }, historyWeight: 20, minSample: 10, inCrm: false, excluded: false })
    expect(small.history.reason).toBe('history_insufficient')
    expect(small.score).toBe(base.score)
    const big = agentScore(company, hotelProfile, null, { history: { hotel: { won: 9, lost: 1 } }, historyWeight: 20, minSample: 10, inCrm: false, excluded: false })
    expect(big.history).toMatchObject({ applied: true, won: 9, lost: 1 })
    expect(big.score).toBe(Math.round((base.score * 80) / 100 + 20 * 0.9))
  })

  it('suggerimento operativo coerente con stato e dati', () => {
    expect(agentScore(company, hotelProfile, null, { history: null, historyWeight: 0, minSample: 10, inCrm: false, excluded: false }).suggestion).toBe('run_research')
    expect(agentScore(company, hotelProfile, null, { history: null, historyWeight: 0, minSample: 10, inCrm: true, excluded: false }).suggestion).toBe('review_in_crm')
    expect(agentScore(company, hotelProfile, null, { history: null, historyWeight: 0, minSample: 10, inCrm: false, excluded: true }).suggestion).toBe('none_excluded')
  })

  it('ricalcolo quando cambiano le informazioni (candidati e lead), senza crediti', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', { sector: 'hotel', location: 'Roma', analyze_top: 0 })
    await runWorkflow(h.engineDeps, workflow_id)
    const c = h.lf.state.candidates[0]!
    // Cambia il profilo: Roma non è più un'area target.
    h.lf.state.profiles[ORG_A] = { ...hotelProfile, targetRegions: ['Milano'] }
    const r = await rescore({ leadFinder: h.lf.store, sales: h.sales.store, store: h.agents.store }, { orgId: ORG_A, config: {} }, { candidate_ids: [c.id, 'ffffffff-ffff-4fff-8fff-ffffffffffff'], lead_ids: [] })
    expect(r.results[0]).toMatchObject({ outcome: 'updated' })
    expect(r.results[0]!.score!).toBeLessThan(r.results[0]!.previous!)
    expect(r.results[1]).toMatchObject({ outcome: 'not_found' })
    expect(h.agents.state.costs.filter((x) => x.credits > 0)).toHaveLength(0)
    expect(USER_A).toBeTruthy()
  })
})
