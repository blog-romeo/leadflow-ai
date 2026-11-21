import type { StepRecord, WorkflowRecord, WorkflowStatus } from './types'

/**
 * Report finale del workflow: solo dati verificabili già salvati dai passi (conteggi, riferimenti a
 * candidati/lead, codici di errore). Nessun testo generato liberamente qui.
 */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

export function buildReport(wf: WorkflowRecord, steps: StepRecord[], status: WorkflowStatus, errorCode: string | null): Record<string, unknown> {
  const out = (action: string) => obj(steps.find((s) => s.action === action)?.output)
  const discover = out('discover')
  const research = out('research')
  const score = out('score')
  const save = out('crm.save_leads')
  const strategy = out('strategy')
  const fuAnalyze = out('follow_up.analyze')
  const fuApply = out('follow_up.apply')
  const growth = out('growth.analyze')

  const highlights: Record<string, unknown> = {}
  if (Object.keys(discover).length) {
    highlights.discovery = { provider: discover.provider ?? null, counts: obj(discover.counts), missing_data: obj(discover.missing_data), unsupported_filters: arr(discover.unsupported_filters) }
  }
  if (Object.keys(research).length) highlights.research = obj(research.counts)
  if (Object.keys(score).length) {
    highlights.scoring = {
      ranked: arr(score.ranked).length,
      top: arr(score.ranked).slice(0, 10).map((r) => {
        const o = obj(r)
        return { candidate_id: o.candidate_id, company_name: o.company_name, score: o.score, priority: o.priority, suggestion: o.suggestion }
      }),
      note: 'compatibility_score_not_probability',
    }
  }
  if (Object.keys(save).length) highlights.crm = obj(save.counts)
  if (Object.keys(strategy).length) highlights.strategy = obj(strategy.counts)
  if (Object.keys(fuAnalyze).length) highlights.follow_up = { ...obj(fuAnalyze.counts), ...(Object.keys(fuApply).length ? { applied: obj(fuApply.counts) } : {}) }
  if (Object.keys(growth).length) highlights.growth = { insights: arr(growth.insights).length, data_gaps: arr(growth.data_gaps) }

  const missingConfig = steps.flatMap((s) => arr(obj(s.output).missing_config)).filter((v): v is string => typeof v === 'string')

  return {
    version: 1,
    template: wf.template,
    status,
    error_code: errorCode,
    generated_at: new Date().toISOString(),
    credits: { budget: wf.budgetCredits, used: wf.creditsUsed },
    cost_usd: wf.costUsd,
    steps: steps.map((s) => ({
      position: s.position,
      agent: s.agentKey,
      action: s.action,
      status: s.status,
      error_code: s.errorCode,
      attempts: s.attempts,
      partial: !!obj(s.output).partial,
      items: num(obj(obj(s.output).counts).total),
    })),
    highlights,
    missing_config: [...new Set(missingConfig)].slice(0, 20),
    // Promemoria esplicito: gli agenti non inviano comunicazioni e il punteggio non è una probabilità.
    guarantees: ['no_messages_sent', 'drafts_require_human_review', 'score_is_not_probability'],
  }
}
