// @vitest-environment node
/**
 * Motore multi-agent: test con store in memoria e servizi SIMULATI (mock di Overpass e OpenAI).
 * Verificano la logica dell'Orchestrator e degli agenti; NON dimostrano le integrazioni reali.
 */
import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../engine'
import { HttpError } from '../../http'
import { makeHarness, overpassHotels, prospecting, ORG_A } from './harness'

async function runToEnd(h: ReturnType<typeof makeHarness>, id: string) {
  return runWorkflow(h.engineDeps, id)
}

describe('1-2. Orchestrazione multi-agent e passaggio dati tra agenti', () => {
  it('prospecting: discovery → research → scoring → approvazione → CRM → strategia → report', async () => {
    const h = makeHarness()
    const started = await h.start('prospecting', prospecting())
    expect(started.created).toBe(true)
    expect(started.status).toBe('pending')

    const first = await runToEnd(h, started.workflow_id)
    expect(first.status).toBe('waiting_approval')
    const [s1, s2, s3, s4, s5] = h.steps(started.workflow_id)
    // Discovery: 6 elementi → 1 senza nome scartato, 1 duplicato (stesso dominio) → 4 aziende.
    expect(s1!.status).toBe('completed')
    expect(s1!.output).toMatchObject({ provider: 'osm_overpass', counts: { found: 4, duplicates_in_batch: 1 } })
    const discovered = s1!.output!.candidate_ids as string[]
    expect(discovered).toHaveLength(4)
    // Research usa ESATTAMENTE i candidati della Discovery.
    expect(s2!.status).toBe('completed')
    expect(h.analyzeCalls.sort()).toEqual(['Albergo Cielo', 'Hotel Aurora', 'Hotel Bellavista', 'Hotel Senza Sito'])
    expect(s2!.output!.counts).toMatchObject({ analyzed: 4, failed: 0 })
    // Scoring usa le analisi della Research (base "ai").
    expect(s3!.status).toBe('completed')
    const ranked = s3!.output!.ranked as { candidate_id: string; score: number; basis: string }[]
    expect(ranked.every((r) => r.basis === 'ai')).toBe(true)
    expect(new Set(ranked.map((r) => r.candidate_id))).toEqual(new Set(discovered))
    expect(s3!.output!.measure).toBe('compatibility_index')
    // Operazione ad alto impatto ferma in attesa di approvazione; nessun lead ancora nel CRM.
    expect(s4!.status).toBe('waiting_approval')
    expect(s5!.status).toBe('pending')
    expect(h.lf.state.leads).toHaveLength(0)
    const approval = h.approvalFor(started.workflow_id)!
    expect(approval.action).toBe('crm.save_leads')
    expect(approval.summary).toMatchObject({ count: 2, estimated_strategy_credits: 4 })

    h.agents.rpc.decide(approval.id, ORG_A, 'approve')
    const second = await runToEnd(h, started.workflow_id)
    expect(second.status).toBe('completed')
    const after = h.steps(started.workflow_id)
    expect(after.map((s) => s.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed'])
    // Il CRM contiene SOLO i 2 candidati approvati; la strategia lavora su quei lead.
    expect(h.lf.state.leads).toHaveLength(2)
    const approvedIds = (approval.summary.candidates as { candidate_id: string }[]).map((c) => c.candidate_id)
    expect(h.lf.state.candidates.filter((c) => c.status === 'saved').map((c) => c.id).sort()).toEqual([...approvedIds].sort())
    expect(after[4]!.output!.counts).toMatchObject({ generated: 2, drafts: 2, failed: 0 })
    expect(h.sales.state.drafts).toHaveLength(2)
    // La strategia riceve le evidenze della Research.
    expect(h.aiCalls[0]!.user).toContain('Le prenotazioni avvengono via email')

    const wf = h.workflow(started.workflow_id)
    expect(wf.creditsUsed).toBe(4 * 1 + 2 * 2)
    expect(wf.report).toMatchObject({ status: 'completed', template: 'prospecting', credits: { budget: 100 }, guarantees: ['no_messages_sent', 'drafts_require_human_review', 'score_is_not_probability'] })
    expect(h.agents.state.costs.filter((c) => c.kind === 'ai_tokens').reduce((a, c) => a + c.credits, 0)).toBe(8)
    // Evidenze classificate e mai FACT senza fonte.
    const ev = h.agents.state.evidence
    expect(ev.some((e) => e.kind === 'fact')).toBe(true)
    expect(ev.some((e) => e.kind === 'inference')).toBe(true)
    expect(ev.some((e) => e.kind === 'unknown' && e.statement === 'Fatturato')).toBe(true)
    expect(ev.filter((e) => e.kind === 'fact').every((e) => e.sourceType !== 'ai' && !!e.evidence)).toBe(true)
    // I bisogni ipotizzati restano deduzioni.
    expect(ev.filter((e) => e.statement === 'Booking engine').every((e) => e.kind === 'inference')).toBe(true)
  })
})

describe('14. Operazioni che richiedono approvazione', () => {
  it('rifiuto: nessun salvataggio nel CRM, strategia saltata, workflow parziale', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting())
    await runToEnd(h, workflow_id)
    h.agents.rpc.decide(h.approvalFor(workflow_id)!.id, ORG_A, 'reject')
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('partial')
    expect(h.lf.state.leads).toHaveLength(0)
    expect(h.steps(workflow_id).map((s) => [s.status, s.errorCode])).toEqual([
      ['completed', null], ['completed', null], ['completed', null], ['skipped', 'approval_rejected'], ['skipped', 'dependency_not_completed'],
    ])
    expect(h.sales.state.drafts).toHaveLength(0)
  })

  it('un approval_id falsificato nell’input del passo non autorizza l’operazione', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting())
    await runToEnd(h, workflow_id)
    const st = h.agents.state.steps.find((s) => s.workflowId === workflow_id && s.position === 4)!
    // Qualcuno altera il passo senza passare dalla RPC di approvazione.
    st.status = 'pending'
    st.input = { approval_id: h.approvalFor(workflow_id)!.id }
    Object.assign(h.workflow(workflow_id), { status: 'pending', lockToken: null, lockedUntil: null })
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('partial')
    expect(h.steps(workflow_id)[3]).toMatchObject({ status: 'failed', errorCode: 'approval_invalid' })
    expect(h.lf.state.leads).toHaveLength(0)
  })

  it('il passo approvato salva solo i candidati del riepilogo approvato nel database', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting({ proposals_top: 1 }))
    await runToEnd(h, workflow_id)
    const ap = h.approvalFor(workflow_id)!
    // Manomissione dell'output del passo di scoring dopo la richiesta: non deve avere effetto.
    const scoring = h.agents.state.steps.find((s) => s.workflowId === workflow_id && s.position === 3)!
    scoring.output = { ...scoring.output!, eligible_ids: (scoring.output!.ranked as { candidate_id: string }[]).map((r) => r.candidate_id) }
    h.agents.rpc.decide(ap.id, ORG_A, 'approve')
    await runToEnd(h, workflow_id)
    expect(h.lf.state.leads).toHaveLength(1)
  })
})

describe('8. Retry controllati e idempotenza', () => {
  it('provider temporaneamente non disponibile: secondo tentativo riuscito', async () => {
    let calls = 0
    const h = makeHarness({ overpass: () => (++calls === 1 ? new Response('busy', { status: 503 }) : new Response(JSON.stringify(overpassHotels), { status: 200 })) })
    const { workflow_id } = await h.start('prospecting', prospecting({ analyze_top: 0, proposals_top: 0 }))
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('completed')
    expect(calls).toBe(2)
    expect(h.steps(workflow_id)[0]).toMatchObject({ status: 'completed', attempts: 2 })
    expect(h.agents.state.runs.filter((x) => x.agentKey === 'discovery').map((x) => x.status)).toEqual(['failed', 'succeeded'])
  })

  it('errore non temporaneo: nessun nuovo tentativo', async () => {
    const h = makeHarness({ overpass: () => new Response('bad', { status: 400 }) })
    const { workflow_id } = await h.start('prospecting', prospecting({ analyze_top: 0, proposals_top: 0 }))
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('failed')
    expect(h.steps(workflow_id)[0]).toMatchObject({ status: 'failed', attempts: 1, errorCode: 'provider_bad_request' })
  })

  it('stessa chiave di idempotenza → stesso workflow; un workflow concluso non viene rieseguito', async () => {
    const h = makeHarness()
    const a = await h.start('growth_report', {}, 0, 'same-key-0001')
    const b = await h.start('growth_report', {}, 0, 'same-key-0001')
    expect(b.workflow_id).toBe(a.workflow_id)
    expect(b.created).toBe(false)
    expect(h.agents.state.workflows).toHaveLength(1)
    expect((await runToEnd(h, a.workflow_id)).status).toBe('completed')
    expect((await runToEnd(h, a.workflow_id)).status).toBe('skipped')
  })

  it('lease attivo: un secondo esecutore concorrente non parte', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('growth_report', {}, 0)
    expect(await h.agents.store.claimWorkflow(workflow_id, 'other-runner', 60)).not.toBeNull()
    expect((await runToEnd(h, workflow_id)).status).toBe('skipped')
  })

  it('ripresa dopo interruzione dell’invocazione: gli elementi già analizzati non vengono rianalizzati né riaddebitati', async () => {
    const h = makeHarness({ maxWallMs: -1 })
    const { workflow_id } = await h.start('prospecting', prospecting({ proposals_top: 0 }))
    // Ogni punto di controllo cede subito: il workflow avanza un elemento per invocazione.
    let guard = 0
    let r = await runToEnd(h, workflow_id)
    while (r.status === 'yielded' && guard++ < 30) r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('completed')
    expect(h.analyzeCalls).toHaveLength(4)
    expect(h.workflow(workflow_id).creditsUsed).toBe(4)
    expect(h.workflow(workflow_id).resumeCount).toBeGreaterThan(1)
    expect(h.lf.state.jobs.filter((j) => j.status === 'succeeded')).toHaveLength(4)
  })

  it('cache per organizzazione: una seconda analisi recente non consuma crediti', async () => {
    const h = makeHarness()
    const w1 = await h.start('prospecting', prospecting({ proposals_top: 0 }))
    await runToEnd(h, w1.workflow_id)
    const w2 = await h.start('prospecting', prospecting({ proposals_top: 0 }))
    await runToEnd(h, w2.workflow_id)
    expect(h.analyzeCalls).toHaveLength(4)
    expect(h.workflow(w2.workflow_id).creditsUsed).toBe(0)
    expect(h.steps(w2.workflow_id)[1]!.output!.counts).toMatchObject({ cached: 4, analyzed: 0 })
  })
})

describe('7. Interruzione del workflow', () => {
  it('interruzione richiesta durante l’analisi: si ferma al punto di controllo successivo', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting({ proposals_top: 0 }))
    let n = 0
    const base = h.engineDeps.services.analyze!
    h.engineDeps.services.analyze = (async (p: Parameters<typeof base>[0]) => {
      if (++n === 2) h.agents.rpc.cancel(workflow_id)
      return base(p)
    }) as typeof base
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('cancelled')
    expect(n).toBe(2)
    const wf = h.workflow(workflow_id)
    expect(wf.errorCode).toBe('cancelled_by_user')
    expect(wf.creditsUsed).toBe(2)
    expect(h.steps(workflow_id).map((s) => s.status)).toEqual(['completed', 'cancelled', 'cancelled'])
  })

  it('interruzione di un workflow in attesa di approvazione: immediata', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting())
    await runToEnd(h, workflow_id)
    h.agents.rpc.cancel(workflow_id)
    expect(h.workflow(workflow_id).status).toBe('cancelled')
    expect(h.agents.state.approvals.find((a) => a.workflowId === workflow_id)!.status).toBe('cancelled')
    expect((await runToEnd(h, workflow_id)).status).toBe('skipped')
  })
})

describe('6. Budget superato', () => {
  it('budget del workflow: si ferma prima di superarlo, risultati parziali conservati', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting({ proposals_top: 0 }), 2)
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('partial')
    expect(h.analyzeCalls).toHaveLength(2)
    const wf = h.workflow(workflow_id)
    expect(wf.creditsUsed).toBe(2)
    expect(wf.errorCode).toBe('workflow_budget_exceeded')
    expect(h.steps(workflow_id)[1]).toMatchObject({ status: 'failed', errorCode: 'workflow_budget_exceeded' })
    expect(h.steps(workflow_id)[2]!.errorCode).toBe('workflow_budget_exceeded')
  })

  it('budget mensile dell’organizzazione per gli agenti', async () => {
    const h = makeHarness({ agent: { configs: [{ org: ORG_A, agentKey: 'orchestrator', enabled: true, modelTier: 'standard', monthlyCreditBudget: 1, maxCreditsPerRun: null, config: {} }] } })
    const { workflow_id } = await h.start('prospecting', prospecting({ proposals_top: 0 }), 100)
    await runToEnd(h, workflow_id)
    expect(h.analyzeCalls).toHaveLength(1)
    expect(h.workflow(workflow_id).errorCode).toBe('org_agent_budget_exceeded')
  })

  it('crediti del piano esauriti (trigger di billing): il workflow si ferma', async () => {
    const h = makeHarness({ agent: { planCredits: 2 } })
    const { workflow_id } = await h.start('prospecting', prospecting({ analyze_top: 0, proposals_top: 2 }))
    await runToEnd(h, workflow_id)
    h.agents.rpc.decide(h.approvalFor(workflow_id)!.id, ORG_A, 'approve')
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('partial')
    expect(h.workflow(workflow_id).errorCode).toBe('billing_insufficient_credits')
    expect(h.sales.state.drafts).toHaveLength(1)
  })
})

describe('5. Provider assente', () => {
  it('nessuna fonte configurata: avvio bloccato con la configurazione necessaria', async () => {
    const h = makeHarness({ env: { OVERPASS_API_URL: '', OVERPASS_CONTACT: '' } })
    const err = await h.start('prospecting', prospecting()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe('plan_blocked')
    const missing = (err as HttpError).details!.missing as { code: string; env?: string[] }[]
    expect(missing).toContainEqual(expect.objectContaining({ code: 'provider_not_configured', env: expect.arrayContaining(['OVERPASS_API_URL']) }))
  })

  it('provider rimosso dopo l’avvio: la Discovery si ferma con un codice chiaro', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting())
    h.engineDeps.services.registry.osm_overpass.missingConfig = () => ['OVERPASS_API_URL']
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('failed')
    expect(h.workflow(workflow_id).errorCode).toBe('provider_not_configured')
    expect(h.http.calls).toHaveLength(0)
  })

  it('AI non configurata: l’avvio con analisi è bloccato; senza analisi procede', async () => {
    const h = makeHarness({ env: { OPENAI_API_KEY: '' } })
    const err = await h.start('prospecting', prospecting()).catch((e: unknown) => e)
    expect((err as HttpError).code).toBe('plan_blocked')
    const ok = await h.start('prospecting', prospecting({ analyze_top: 0, proposals_top: 0 }))
    expect((await runToEnd(h, ok.workflow_id)).status).toBe('completed')
  })
})

describe('12-13. Lead duplicati e dati mancanti', () => {
  it('duplicati nel batch, già noti e già nel CRM non vengono duplicati', async () => {
    const h = makeHarness()
    const w1 = await h.start('prospecting', prospecting({ analyze_top: 0, proposals_top: 2, min_score: 0 }))
    await runToEnd(h, w1.workflow_id)
    h.agents.rpc.decide(h.approvalFor(w1.workflow_id)!.id, ORG_A, 'approve')
    await runToEnd(h, w1.workflow_id)
    expect(h.lf.state.leads).toHaveLength(2)

    const w2 = await h.start('prospecting', prospecting({ analyze_top: 0, proposals_top: 4, min_score: 0 }))
    await runToEnd(h, w2.workflow_id)
    const disc = h.steps(w2.workflow_id)[0]!.output!.counts as Record<string, number>
    expect(disc).toMatchObject({ duplicates_in_batch: 1, already_known: 4, in_crm: 2, new: 0 })
    h.agents.rpc.decide(h.approvalFor(w2.workflow_id)!.id, ORG_A, 'approve')
    await runToEnd(h, w2.workflow_id)
    const byPos = (p: number) => h.steps(w2.workflow_id).find((s) => s.position === p)!
    expect(byPos(4).output!.counts).toMatchObject({ saved: 2, already_saved: 2 })
    expect(h.lf.state.leads).toHaveLength(4)
    // Strategie già generate per gli stessi dati: riusate dalla cache, nessuna bozza duplicata.
    expect(byPos(5).output!.counts).toMatchObject({ generated: 2, cached: 2, drafts: 2 })
    expect(h.sales.state.drafts).toHaveLength(4)
  })

  it('dati mancanti segnalati da Discovery, Research e Scoring (mai inventati)', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting({ proposals_top: 0, company_size: 'small' }))
    await runToEnd(h, workflow_id)
    const [d, , s] = h.steps(workflow_id)
    expect(d!.output!.missing_data).toMatchObject({ website: 1, phone: 2, company_size: 4 })
    expect(d!.output!.unsupported_filters).toEqual(['company_size'])
    const noSite = (s!.output!.ranked as { company_name: string; missing: string[]; website: string | null }[]).find((r) => r.company_name === 'Hotel Senza Sito')!
    expect(noSite.website).toBeNull()
    expect(noSite.missing).toEqual(expect.arrayContaining(['website', 'phone', 'Numero di camere']))
    expect(h.lf.state.candidates.find((c) => c.companyName === 'Hotel Senza Sito')!.phone).toBeNull()
    expect(h.agents.state.evidence.filter((e) => e.kind === 'unknown').length).toBeGreaterThan(0)
  })
})

describe('Timeout', () => {
  it('passo bloccato: timeout, un nuovo tentativo, poi errore; il workflow non resta appeso', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('growth_report', {}, 0)
    // Solo test: timeout di 50 ms (nel database il minimo è 10 s).
    h.agents.state.steps.find((s) => s.workflowId === workflow_id)!.timeoutSeconds = 0.05
    let calls = 0
    h.engineDeps.handlers = { ...h.engineDeps.handlers, 'growth.analyze': { agent: 'growth_analyst', run: () => (calls++, new Promise(() => undefined)) } }
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('failed')
    expect(calls).toBe(2)
    expect(h.steps(workflow_id)[0]).toMatchObject({ status: 'failed', errorCode: 'step_timeout', attempts: 2 })
    expect(h.agents.state.runs.map((x) => x.status)).toEqual(['timed_out', 'timed_out'])
  })

  it('scadenza complessiva del workflow superata: chiusura con risultati parziali', async () => {
    const h = makeHarness()
    const { workflow_id } = await h.start('prospecting', prospecting({ proposals_top: 0 }))
    let now = Date.now()
    h.engineDeps.now = () => new Date(now)
    const base = h.engineDeps.services.analyze!
    h.engineDeps.services.analyze = (async (p: Parameters<typeof base>[0]) => {
      now += 2 * 3_600_000 // ogni analisi "dura" due ore
      return base(p)
    }) as typeof base
    const r = await runToEnd(h, workflow_id)
    expect(r.status).toBe('partial')
    expect(h.workflow(workflow_id).errorCode).toBe('workflow_timeout')
    expect(h.analyzeCalls).toHaveLength(1)
  })
})
