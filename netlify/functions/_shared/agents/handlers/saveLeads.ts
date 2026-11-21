import { saveToCrm } from '../../lead-finder/services'
import type { ProviderId } from '../../lead-finder/types'
import { AgentError } from '../errors'
import type { StepContext, StepHandler, StepResult } from '../engine'
import type { ProspectingParams } from '../validation'

/**
 * Orchestrator — salvataggio nel CRM dei lead più compatibili (operazione ad ALTO IMPATTO).
 *
 * Prima dell'esecuzione il motore crea una richiesta di approvazione con l'elenco esatto dei candidati e
 * la stima dei crediti dei passi successivi. Dopo l'approvazione vengono salvati SOLO i candidati presenti
 * nel riepilogo approvato letto dal database. Il salvataggio riusa saveToCrm del Lead Finder: licenze,
 * soppressioni (opposizioni), deduplica e quota lead del piano restano applicate dal codice esistente.
 */
const PROVIDER_LABELS: Record<ProviderId, string> = {
  osm_overpass: 'OpenStreetMap (Overpass)',
  google_places: 'Google Places',
  csv_import: 'Importazione CSV',
}

interface ApprovedCandidate {
  candidate_id: string
  company_name: string | null
  score: number
  priority: string
  in_crm: boolean
}

export const saveLeadsHandler: StepHandler = {
  agent: 'orchestrator',
  async prepareApproval(ctx: StepContext) {
    const p = ctx.workflow.params as unknown as ProspectingParams
    const scoring = ctx.prior(3)
    const ranked = (scoring?.ranked as { candidate_id: string; company_name: string | null; score: number; priority: string; status: string; lead_id: string | null }[] | undefined) ?? []
    const eligible = new Set((scoring?.eligible_ids as string[] | undefined) ?? [])
    const chosen = ranked.filter((r) => eligible.has(r.candidate_id)).slice(0, p.proposals_top)
    if (!chosen.length) return null
    const candidates: ApprovedCandidate[] = chosen.map((r) => ({ candidate_id: r.candidate_id, company_name: r.company_name, score: r.score, priority: r.priority, in_crm: r.status === 'saved' }))
    return {
      action: 'crm.save_leads',
      summary: {
        candidates,
        count: candidates.length,
        new_leads: candidates.filter((c) => !c.in_crm).length,
        next_step: 'strategy',
        estimated_strategy_credits: candidates.length * (ctx.creditCosts.sales_strategy ?? 0),
        notes: ['leads_saved_to_crm', 'plan_lead_quota_may_apply', 'drafts_only_no_messages_sent'],
      },
    }
  },
  async run(ctx: StepContext): Promise<StepResult> {
    const approved = (ctx.approvalSummary?.candidates as ApprovedCandidate[] | undefined) ?? []
    if (!ctx.approvalId || !approved.length) throw new AgentError('approval_invalid')
    const ids = approved.map((c) => c.candidate_id).slice(0, 50)
    const res = await ctx.tools.call(
      'crm.save_leads',
      { count: ids.length, approval_id: ctx.approvalId },
      () => saveToCrm({ store: ctx.services.leadFinder, providerLabels: PROVIDER_LABELS }, { orgId: ctx.orgId, userId: ctx.userId }, ids),
      { summarizeResult: (r) => ({ saved: r.saved }) },
    )
    await ctx.store.audit(ctx.orgId, ctx.userId, 'ai_agent.crm_saved', 'ai_workflow', ctx.workflow.id, { approval_id: ctx.approvalId, saved: res.saved, requested: ids.length })
    const by = (o: string) => res.results.filter((r) => r.outcome === o).length
    const leadIds = res.results.filter((r) => r.lead_id && (r.outcome === 'saved' || r.outcome === 'already_saved')).map((r) => r.lead_id as string)
    const failed = res.results.filter((r) => !['saved', 'already_saved'].includes(r.outcome)).length
    return {
      output: {
        results: res.results,
        lead_ids: leadIds,
        counts: { total: ids.length, saved: by('saved'), already_saved: by('already_saved'), duplicate: by('duplicate'), suppressed: by('suppressed'), not_allowed: by('not_allowed'), excluded: by('excluded'), not_found: by('not_found') },
      },
      itemsTotal: ids.length,
      itemsFailed: failed,
      partial: failed > 0,
    }
  },
}
