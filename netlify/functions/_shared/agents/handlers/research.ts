import { aiMissingConfig, runAnalysisJob } from '../../lead-finder/analysisService'
import type { AnalysisResult } from '../../lead-finder/analysis/schema'
import type { CandidateRecord } from '../../lead-finder/store'
import { sanitizeUntrusted } from '../../sales-agent/sanitize'
import { AgentError } from '../errors'
import type { StepContext, StepHandler, StepResult } from '../engine'
import { envForTask, estimateTierCost } from '../models'
import type { EvidenceWrite } from '../types'

/**
 * AI Research Agent — analisi aziendale da fonti accessibili legittimamente (dati del provider e sito web
 * pubblico, nel rispetto di robots.txt e con protezione SSRF: è l'Analyzer esistente).
 *
 * Ogni risultato è classificato:
 *   FACT      = dato verificato, con fonte ed estratto (il database rifiuta un FACT senza fonte);
 *   INFERENCE = deduzione dell'AI, con motivazione;
 *   UNKNOWN   = dato non disponibile.
 * Bisogni e intenzioni di acquisto non dichiarati non vengono mai registrati come fatti; le deduzioni che
 * attribuiscono un'intenzione di acquisto vengono scartate.
 */
const INTENT_RE =
  /(intend\w*\s+(?:to\s+)?(?:buy|purchase)|intenzion\w*\s+di\s+acquist|vuol\w*\s+acquist|sta(?:nno)?\s+cercando\s+(?:un|una|dei|delle)?\s*(?:fornitor|agenzi|consulent)|looking\s+(?:to\s+buy|for\s+a\s+(?:supplier|vendor|agency))|ready\s+to\s+buy|pront\w+\s+(?:ad?|all['’])\s*acquist|budget\s+(?:approvato|stanziato|approved))/i

export function evidenceFromAnalysis(a: AnalysisResult, c: Pick<CandidateRecord, 'id' | 'sourceUrl'>, ids: { workflowId: string | null; runId: string | null }): { rows: EvidenceWrite[]; intentRemoved: number } {
  const rows: EvidenceWrite[] = []
  let intentRemoved = 0
  const base = { workflowId: ids.workflowId, runId: ids.runId, subjectType: 'candidate' as const, subjectId: c.id, observedAt: a.analyzed_at }
  const clean = (s: string, max = 1000) => sanitizeUntrusted(s ?? '', max)
  const fact = (category: EvidenceWrite['category'], statement: string, evidence: string, source: 'provider' | 'website', url: string | null) => {
    const ev = clean(evidence)
    if (!clean(statement)) return
    if (!ev) {
      // Senza estratto non è un fatto verificabile: viene declassato a deduzione.
      rows.push({ ...base, category, kind: 'inference', statement: clean(statement), evidence: null, sourceType: 'ai', sourceUrl: null, rationale: 'evidence_missing' })
      return
    }
    rows.push({ ...base, category, kind: 'fact', statement: clean(statement), evidence: ev, sourceType: source, sourceUrl: url, rationale: null })
  }
  const inference = (category: EvidenceWrite['category'], statement: string, rationale: string | null) => {
    if (!clean(statement)) return
    if (INTENT_RE.test(statement) || INTENT_RE.test(rationale ?? '')) {
      intentRemoved++
      return
    }
    rows.push({ ...base, category, kind: 'inference', statement: clean(statement), evidence: null, sourceType: 'ai', sourceUrl: null, rationale: rationale ? clean(rationale) : null })
  }
  const unknown = (category: EvidenceWrite['category'], statement: string, rationale: string | null = null) => {
    if (!clean(statement)) return
    rows.push({ ...base, category, kind: 'unknown', statement: clean(statement), evidence: null, sourceType: 'none', sourceUrl: null, rationale })
  }
  const siteUrl = a.website.url && /^https?:\/\//i.test(a.website.url) ? a.website.url : null
  const providerUrl = c.sourceUrl && /^https?:\/\//i.test(c.sourceUrl) ? c.sourceUrl : null

  for (const f of a.verified_facts) fact('profile', f.statement, f.evidence, f.source, f.source === 'website' ? siteUrl : providerUrl)
  const basisRow = (category: EvidenceWrite['category'], label: string, v: AnalysisResult['sector']) => {
    if (v.basis === 'verified') fact(category, `${label}: ${v.value}`, v.evidence, 'website', siteUrl)
    else if (v.basis === 'hypothesis') inference(category, `${label}: ${v.value}`, v.evidence || null)
    else unknown(category, label)
  }
  basisRow('sector', 'Settore', a.sector)
  basisRow('products_services', 'Attività', a.activity_description)
  if (a.website.status === 'analyzed' && siteUrl) fact('digital_presence', 'Sito web raggiungibile e analizzato', siteUrl, 'website', siteUrl)
  else if (a.website.status === 'no_website') unknown('digital_presence', 'Sito web', 'no_website')
  else unknown('digital_presence', 'Contenuti del sito', a.website.status)
  for (const s of a.signals) {
    if (s.verified) fact('signal', s.signal, s.evidence, 'website', siteUrl)
    else inference('signal', s.signal, 'signal_not_verified_in_source')
  }
  for (const h of a.hypotheses) inference('profile', h.statement, h.rationale)
  for (const n of a.digital_needs) inference('opportunity', n.need, n.rationale)
  for (const o of a.opportunities) inference('opportunity', o.opportunity, o.rationale)
  inference('fit', `Coerenza settore ${a.fit.sector_rating}/10`, a.fit.sector_reason)
  inference('fit', `Coerenza cliente ideale ${a.fit.icp_rating}/10`, a.fit.icp_reason)
  for (const m of a.missing_information) unknown('missing', m)
  return { rows: rows.slice(0, 80), intentRemoved }
}

interface ResearchProgress {
  processed: Record<string, 'analyzed' | 'cached' | 'failed' | 'skipped_license' | 'skipped_excluded' | 'not_found'>
  facts: number
  inferences: number
  unknowns: number
  intent_removed: number
  tokens_input: number
  tokens_output: number
}

export const researchHandler: StepHandler = {
  agent: 'research',
  async run(ctx: StepContext): Promise<StepResult> {
    const p = ctx.workflow.params as { analyze_top?: number }
    const discovered = ctx.prior(1)
    const ids = ((discovered?.candidate_ids as string[] | undefined) ?? []).slice(0, Math.max(0, p.analyze_top ?? 0))
    const { env: tierEnv, choice } = envForTask('company_analysis', ctx.config.modelTier, ctx.env)
    const missing = aiMissingConfig({ ...tierEnv, LEADFLOW_INTERNAL_SECRET: ctx.env.LEADFLOW_INTERNAL_SECRET })
    if (missing.length) throw new AgentError('ai_not_configured', { stopWorkflow: true, details: { missing } })

    const lf = ctx.services.leadFinder
    const cacheDays = ctx.config.config.cache_days ?? 30
    const credit = ctx.creditCosts.business_analysis ?? 1
    const prog: ResearchProgress = {
      processed: {},
      facts: 0,
      inferences: 0,
      unknowns: 0,
      intent_removed: 0,
      tokens_input: 0,
      tokens_output: 0,
      ...(ctx.progress as Partial<ResearchProgress>),
    }
    prog.processed = { ...(prog.processed ?? {}) }

    const addEvidence = async (c: CandidateRecord, a: AnalysisResult) => {
      const { rows, intentRemoved } = evidenceFromAnalysis(a, c, { workflowId: ctx.workflow.id, runId: ctx.runId })
      await ctx.tools.call('evidence.write', { candidate_id: c.id, count: rows.length }, () => ctx.store.insertEvidence(ctx.orgId, rows))
      prog.facts += rows.filter((r) => r.kind === 'fact').length
      prog.inferences += rows.filter((r) => r.kind === 'inference').length
      prog.unknowns += rows.filter((r) => r.kind === 'unknown').length
      prog.intent_removed += intentRemoved
    }

    for (const id of ids) {
      if (prog.processed[id]) continue
      const [c] = await ctx.tools.call('candidates.read', { candidate_id: id }, () => lf.getCandidates(ctx.orgId, [id]))
      if (!c) {
        prog.processed[id] = 'not_found'
      } else if (!c.canStoreContent) {
        prog.processed[id] = 'skipped_license'
      } else if (c.status === 'excluded') {
        prog.processed[id] = 'skipped_excluded'
      } else if (c.analysis && c.lastAnalyzedAt && ctx.now().getTime() - new Date(c.lastAnalyzedAt).getTime() < cacheDays * 86_400_000) {
        // Cache per organizzazione: analisi recente già pagata, nessun nuovo credito.
        await addEvidence(c, c.analysis)
        await ctx.recordCost({ kind: 'ai_tokens', aiJobId: null, model: c.analysis.model, tokensInput: 0, tokensOutput: 0, credits: 0, costUsd: 0, cacheHit: true })
        prog.processed[id] = 'cached'
      } else {
        // Quote tecniche esistenti (analisi mensili) verificate prima di spendere.
        const [quota, inflight] = await Promise.all([lf.consumeUsage(ctx.orgId, ctx.userId, 'ai_analysis', 0), lf.countInflightAnalyses(ctx.orgId)])
        if (quota.remaining - inflight <= 0) throw new AgentError('quota_ai_exceeded', { stopWorkflow: true, details: { used: quota.used, limit: quota.limit } })
        ctx.budget.reserve('research', credit)
        let status: 'succeeded' | 'failed' | 'skipped'
        let jobId: string
        try {
          ;({ jobId, status } = await ctx.tools.call(
            'ai.analyze_company',
            { candidate_id: id, model_tier: choice.effective },
            async () => {
              const job = await lf.createAiJob({ org: ctx.orgId, candidateId: id, input: { keywords: [], workflow_id: ctx.workflow.id }, createdBy: ctx.userId })
              const r = await runAnalysisJob({ store: lf, env: tierEnv, analyze: ctx.services.analyze }, job)
              return { jobId: job, status: r }
            },
            { summarizeResult: (r) => ({ status: r.status }) },
          ))
        } catch (err) {
          ctx.budget.refund('research', credit)
          throw err
        }
        if (status !== 'succeeded') {
          ctx.budget.refund('research', credit)
          prog.processed[id] = 'failed'
        } else {
          const [fresh] = await lf.getCandidates(ctx.orgId, [id])
          if (fresh?.analysis) {
            await addEvidence(fresh, fresh.analysis)
            const usage = fresh.analysis.usage
            prog.tokens_input += usage.input_tokens
            prog.tokens_output += usage.output_tokens
            await ctx.recordCost({ kind: 'ai_tokens', aiJobId: jobId, model: fresh.analysis.model, tokensInput: usage.input_tokens, tokensOutput: usage.output_tokens, credits: credit, costUsd: estimateTierCost(usage, choice.effective, ctx.env), cacheHit: false })
          }
          prog.processed[id] = 'analyzed'
        }
      }
      await ctx.checkpoint(prog as unknown as Record<string, unknown>)
    }

    const values = Object.values(prog.processed)
    const failed = values.filter((v) => v === 'failed').length
    const counts = {
      total: ids.length,
      analyzed: values.filter((v) => v === 'analyzed').length,
      cached: values.filter((v) => v === 'cached').length,
      failed,
      skipped: values.filter((v) => v.startsWith('skipped') || v === 'not_found').length,
      facts: prog.facts,
      inferences: prog.inferences,
      unknowns: prog.unknowns,
      intent_removed: prog.intent_removed,
    }
    return {
      output: { counts, results: prog.processed, model_tier: choice.effective, model_fallback: choice.fallback },
      itemsTotal: ids.length,
      itemsFailed: failed,
      model: choice.model,
      tokensInput: prog.tokens_input,
      tokensOutput: prog.tokens_output,
    }
  },
}
