import { aiMissingConfig } from '../../lead-finder/analysisService'
import { runSalesJob } from '../../sales-agent/service'
import { AgentError, toAgentError } from '../errors'
import type { StepContext, StepHandler, StepResult } from '../engine'
import { envForTask } from '../models'
import type { FollowUpTaskCreate } from '../store'
import type { FollowUpParams } from '../validation'

/**
 * AI Follow-up Agent.
 *
 * Analisi (deterministica, senza crediti): attività CRM, opportunità senza aggiornamenti, trattative ferme,
 * follow-up scaduti. Applicazione (dopo APPROVAZIONE esplicita): promemoria interni (follow_up_tasks con
 * source "ai"), blocco dei promemoria di contatto rimasti aperti su lead non più contattabili e, se
 * richiesto, bozze di follow-up (nessun invio). Opposizioni e stati di non contattabilità sono sempre
 * rispettati: per questi lead non si propone alcun contatto (lo impone anche il trigger del database).
 */
interface Proposal {
  create: (FollowUpTaskCreate & { reason: 'stale_lead' | 'stale_opportunity'; company_name: string })[]
  block: { task_id: string; lead_id: string; company_name: string }[]
}

export const followUpAnalyzeHandler: StepHandler = {
  agent: 'follow_up',
  async run(ctx: StepContext): Promise<StepResult> {
    const p = ctx.workflow.params as unknown as FollowUpParams
    const staleDays = p.stale_days ?? ctx.config.config.stale_days ?? 14
    const oppDays = p.opportunity_stale_days ?? ctx.config.config.opportunity_stale_days ?? 30
    const maxTasks = Math.min(p.max_tasks ?? 25, ctx.config.config.max_tasks ?? 50)
    const snap = await ctx.tools.call('crm.read', { stale_days: staleDays, opportunity_stale_days: oppDays }, () =>
      ctx.store.followUpSnapshot(ctx.orgId, { staleDays, opportunityStaleDays: oppDays, limit: 500 }),
    )
    const due = new Date(ctx.now().getTime() + 86_400_000).toISOString()
    const proposal: Proposal = { create: [], block: [] }
    let skippedNotContactable = 0
    let alreadyPlanned = 0

    for (const l of snap.leads) {
      const openContact = l.open_tasks.filter((t) => t.is_contact)
      if (!l.contactable) {
        // Nessun contatto per chi si è opposto o non è contattabile; i promemoria aperti vanno bloccati.
        for (const t of openContact) proposal.block.push({ task_id: t.id, lead_id: l.id, company_name: l.company_name })
        if (l.days_since_activity !== null && l.days_since_activity >= staleDays) skippedNotContactable++
        continue
      }
      if (l.days_since_activity === null || l.days_since_activity < staleDays) continue
      if (l.open_tasks.length > 0) {
        alreadyPlanned++
        continue
      }
      if (proposal.create.length >= maxTasks) break
      proposal.create.push({
        leadId: l.id,
        kind: 'check_in',
        title: `Ricontattare ${l.company_name}`.slice(0, 200),
        notes: `Nessuna attività da ${l.days_since_activity} giorni (fase: ${l.status}). Suggerito dall'AI Follow-up Agent: verificare prima di contattare.`,
        dueAt: due,
        opportunityId: null,
        createdBy: ctx.userId,
        reason: 'stale_lead',
        company_name: l.company_name,
      })
    }
    for (const o of snap.stale_opportunities) {
      if (proposal.create.length >= maxTasks) break
      if (proposal.create.some((c) => c.leadId === o.lead_id && c.kind === 'opportunity_review')) continue
      // La revisione dell'opportunità è interna: ammessa anche se il lead non è contattabile.
      proposal.create.push({
        leadId: o.lead_id,
        kind: 'opportunity_review',
        title: `Rivedere opportunità: ${o.title}`.slice(0, 200),
        notes: `Opportunità senza aggiornamenti da ${o.days_since_update} giorni.`,
        dueAt: due,
        opportunityId: o.id,
        createdBy: ctx.userId,
        reason: 'stale_opportunity',
        company_name: o.title,
      })
    }
    const output = {
      proposal,
      overdue: snap.overdue_tasks.slice(0, 50),
      stalled: snap.stale_opportunities.slice(0, 50),
      counts: {
        total: snap.leads.length,
        to_create: proposal.create.length,
        to_block: proposal.block.length,
        overdue: snap.overdue_tasks.length,
        stale_opportunities: snap.stale_opportunities.length,
        skipped_not_contactable: skippedNotContactable,
        already_planned: alreadyPlanned,
      },
      thresholds: { stale_days: staleDays, opportunity_stale_days: oppDays, max_tasks: maxTasks },
    }
    return { output, itemsTotal: snap.leads.length, itemsFailed: 0 }
  },
}

export const followUpApplyHandler: StepHandler = {
  agent: 'follow_up',
  async prepareApproval(ctx: StepContext) {
    const p = ctx.workflow.params as unknown as FollowUpParams
    const analysis = ctx.prior(1)
    const proposal = analysis?.proposal as Proposal | undefined
    if (!proposal || (proposal.create.length === 0 && proposal.block.length === 0)) return null
    const drafts = p.prepare_drafts ? Math.min(p.drafts_max, proposal.create.filter((c) => c.kind === 'check_in').length) : 0
    return {
      action: 'follow_up.apply',
      summary: {
        create: proposal.create.map((c) => ({ lead_id: c.leadId, kind: c.kind, title: c.title, due_at: c.dueAt, opportunity_id: c.opportunityId, reason: c.reason })),
        block: proposal.block,
        drafts,
        estimated_credits: drafts * (ctx.creditCosts.follow_up_suggestion ?? 0),
        notes: ['internal_reminders_only', 'no_messages_sent'],
      },
    }
  },
  async run(ctx: StepContext): Promise<StepResult> {
    const s = ctx.approvalSummary ?? {}
    const create = (s.create as { lead_id: string; kind: 'check_in' | 'opportunity_review'; title: string; due_at: string; opportunity_id: string | null }[] | undefined) ?? []
    const block = (s.block as { task_id: string }[] | undefined) ?? []
    const drafts = Number(s.drafts ?? 0)
    if (!ctx.approvalId) throw new AgentError('approval_invalid')
    const done = (ctx.progress.done as Record<string, unknown> | undefined) ?? {}

    let created: string[] = (done.created as string[] | undefined) ?? []
    let skipped = Number(done.skipped ?? 0)
    if (!done.tasks) {
      const rows: FollowUpTaskCreate[] = create.slice(0, 50).map((c) => ({ leadId: c.lead_id, kind: c.kind, title: c.title, notes: 'Promemoria interno creato dall’AI Follow-up Agent dopo approvazione.', dueAt: c.due_at, opportunityId: c.opportunity_id, createdBy: ctx.userId }))
      const r = rows.length ? await ctx.tools.call('followups.create', { count: rows.length, approval_id: ctx.approvalId }, () => ctx.store.createFollowUpTasks(ctx.orgId, rows)) : { created: [], skipped: 0 }
      created = r.created
      skipped = r.skipped
      await ctx.checkpoint({ done: { ...done, tasks: true, created, skipped } })
    }
    let blocked = Number(done.blocked ?? 0)
    if (!done.blocks) {
      blocked = block.length ? await ctx.tools.call('followups.block', { count: block.length, approval_id: ctx.approvalId }, () => ctx.store.blockFollowUpTasks(ctx.orgId, block.map((b) => b.task_id), 'lead_not_contactable')) : 0
      await ctx.checkpoint({ done: { ...done, tasks: true, created, skipped, blocks: true, blocked } })
    }

    // Bozze facoltative: un job "follow_up_suggestion" del Sales Agent per promemoria di contatto appena creati.
    const draftResults: Record<string, string> = { ...((done.drafts as Record<string, string> | undefined) ?? {}) }
    let draftFailed = 0
    if (drafts > 0) {
      const { env: tierEnv } = envForTask('follow_up_draft', ctx.config.modelTier, ctx.env)
      const missing = aiMissingConfig({ ...tierEnv, LEADFLOW_INTERNAL_SECRET: ctx.env.LEADFLOW_INTERNAL_SECRET })
      if (missing.length) throw new AgentError('ai_not_configured', { stopWorkflow: true, details: { missing } })
      const credit = ctx.creditCosts.follow_up_suggestion ?? 1
      const sales = ctx.services.sales
      for (const taskId of created) {
        if (Object.keys(draftResults).length >= drafts) break
        if (draftResults[taskId]) continue
        const task = await sales.getFollowUpTask(ctx.orgId, taskId)
        if (!task || task.kind !== 'check_in' || task.status !== 'open') continue
        ctx.budget.reserve('follow_up', credit)
        try {
          const outcome = await ctx.tools.call('ai.follow_up_suggestion', { follow_up_task_id: taskId }, async () => {
            const jobId = await sales.createJob({ org: ctx.orgId, task: 'follow_up_suggestion', leadId: task.lead_id, input: { task: 'follow_up_suggestion', follow_up_task_id: taskId, workflow_id: ctx.workflow.id }, createdBy: ctx.userId })
            return runSalesJob({ store: sales, env: tierEnv, ai: ctx.services.ai }, jobId)
          })
          if (outcome !== 'succeeded') {
            ctx.budget.refund('follow_up', credit)
            draftFailed++
          } else {
            await ctx.recordCost({ kind: 'ai_tokens', aiJobId: null, model: null, tokensInput: 0, tokensOutput: 0, credits: credit, costUsd: null, cacheHit: false })
          }
          draftResults[taskId] = outcome
        } catch (err) {
          ctx.budget.refund('follow_up', credit)
          const e = toAgentError(err)
          if (e.stopWorkflow) throw e
          draftResults[taskId] = 'failed'
          draftFailed++
        }
        await ctx.checkpoint({ done: { tasks: true, created, skipped, blocks: true, blocked, drafts: draftResults } })
      }
    }
    await ctx.store.audit(ctx.orgId, ctx.userId, 'ai_agent.follow_up_applied', 'ai_workflow', ctx.workflow.id, { approval_id: ctx.approvalId, created: created.length, blocked })
    const total = create.length + block.length
    return {
      output: { created_task_ids: created, drafts: draftResults, counts: { total, created: created.length, skipped_existing_or_blocked: skipped, blocked, drafts: Object.values(draftResults).filter((v) => v === 'succeeded').length, drafts_failed: draftFailed }, no_messages_sent: true },
      itemsTotal: total,
      itemsFailed: 0,
      partial: draftFailed > 0,
    }
  },
}
