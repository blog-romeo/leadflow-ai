import { HttpError } from '../http'
import { log } from '../log'
import { analyzeCompany } from './analysis/analyzer'
import { AiError } from './analysis/openai'
import { normalizeWebsite } from './normalize'
import { scoreLead, type ScorableCompany } from './scoring'
import type { LeadFinderStore } from './store'
import type { ProviderId } from './types'
import type { Ctx } from './services'
import { estimateCostUsd } from '../sales-agent/costs'

export function aiMissingConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = []
  if (!env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY')
  if (!env.OPENAI_MODEL) missing.push('OPENAI_MODEL')
  if (!env.LEADFLOW_INTERNAL_SECRET || env.LEADFLOW_INTERNAL_SECRET.length < 32) missing.push('LEADFLOW_INTERNAL_SECRET')
  return missing
}

export interface EphemeralCompany {
  companyName: string
  sector: string | null
  address: string | null
  city: string | null
  country: string | null
  website: string | null
  phone: string | null
}

/**
 * Richiesta di analisi: controlli sincroni (autorizzazione già fatta dal chiamante,
 * rate limit, quota con lavori in corso) e creazione del job; l'esecuzione avviene
 * in una background function per non dipendere dal timeout delle funzioni sincrone.
 */
export async function requestAnalysis(
  deps: { store: LeadFinderStore; env?: NodeJS.ProcessEnv },
  ctx: Ctx,
  input: { candidate_id: string; keywords: string[]; ephemeral?: EphemeralCompany },
): Promise<{ job_id: string }> {
  const { store } = deps
  const missing = aiMissingConfig(deps.env)
  if (missing.length) throw new HttpError(409, 'ai_not_configured', { missing })

  const rl = await store.checkRateLimit(ctx.orgId, ctx.userId, 'ai_analysis')
  if (!rl.allowed) throw new HttpError(429, 'rate_limited', { retry_after: rl.retry_after ?? 60 })

  const [candidate] = await store.getCandidates(ctx.orgId, [input.candidate_id])
  if (!candidate) throw new HttpError(404, 'candidate_not_found')
  if (candidate.status === 'excluded') throw new HttpError(409, 'candidate_excluded')
  if (!candidate.canStoreContent && !input.ephemeral) throw new HttpError(400, 'ephemeral_data_required')

  // Quota: crediti già usati + analisi in corso non devono superare il limite.
  const [quota, inflight] = await Promise.all([store.consumeUsage(ctx.orgId, ctx.userId, 'ai_analysis', 0), store.countInflightAnalyses(ctx.orgId)])
  if (quota.remaining - inflight <= 0) throw new HttpError(429, 'quota_ai_exceeded', { used: quota.used, limit: quota.limit })

  const jobInput: Record<string, unknown> = { keywords: input.keywords }
  if (!candidate.canStoreContent && input.ephemeral) {
    // Dati della sessione (licenza senza memorizzazione): restano nel job solo fino al termine dell'analisi.
    jobInput.ephemeral = { ...input.ephemeral, website: normalizeWebsite(input.ephemeral.website) }
  }
  const jobId = await store.createAiJob({ org: ctx.orgId, candidateId: candidate.id, input: jobInput, createdBy: ctx.userId })
  return { job_id: jobId }
}

const PROVIDER_LABELS: Record<ProviderId, string> = { osm_overpass: 'OpenStreetMap', google_places: 'Google Maps', csv_import: 'importazione CSV' }

/** Esecuzione del job (background function). Non rilancia: lo stato finale è sempre scritto sul job. */
export async function runAnalysisJob(
  deps: { store: LeadFinderStore; env?: NodeJS.ProcessEnv; analyze?: typeof analyzeCompany },
  jobId: string,
): Promise<'succeeded' | 'failed' | 'skipped'> {
  const { store } = deps
  const job = await store.getAiJob(jobId)
  if (!job || job.status !== 'queued' || !job.candidateId) return 'skipped'
  const org = job.organizationId
  await store.updateAiJob(org, jobId, { status: 'running', startedAt: new Date().toISOString() })
  try {
    const [candidate] = await store.getCandidates(org, [job.candidateId])
    if (!candidate) throw new AiError('ai_bad_response')
    const eph = job.input.ephemeral as EphemeralCompany | undefined
    const company: ScorableCompany = candidate.canStoreContent
      ? {
          companyName: candidate.companyName,
          sector: candidate.sector,
          categoryTags: candidate.categoryTags,
          address: candidate.address,
          city: candidate.city,
          region: candidate.region,
          country: candidate.country,
          website: candidate.website,
          phone: candidate.phone,
        }
      : { categoryTags: [], region: null, ...(eph as EphemeralCompany) }
    const profile = await store.getProfile(org)
    const keywords = Array.isArray(job.input.keywords) ? (job.input.keywords as string[]) : []
    const analysis = await (deps.analyze ?? analyzeCompany)({ company, providerLabel: PROVIDER_LABELS[candidate.provider], profile, keywords, env: deps.env })
    const score = scoreLead(company, profile, analysis)
    const now = new Date().toISOString()

    if (candidate.canStoreContent) {
      await store.updateCandidate(org, candidate.id, { analysis, lastAnalyzedAt: now, score })
    }
    // Il credito si consuma solo ad analisi riuscita.
    const actor = job.createdBy ?? '00000000-0000-0000-0000-000000000000'
    await store.consumeUsage(org, actor, 'ai_analysis', 1, { job_id: jobId })
    const tokens = analysis.usage.input_tokens + analysis.usage.output_tokens
    if (tokens > 0) await store.consumeUsage(org, actor, 'ai_tokens', tokens, { job_id: jobId })
    await store.updateAiJob(org, jobId, {
      status: 'succeeded',
      // Per i provider senza memorizzazione il risultato vive nel job; i dati di input vengono rimossi.
      output: candidate.canStoreContent ? { stored_on_candidate: true } : { analysis, score },
      model: analysis.model,
      tokensInput: analysis.usage.input_tokens,
      tokensOutput: analysis.usage.output_tokens,
      costUsd: estimateCostUsd(analysis.usage, deps.env ?? process.env),
      completedAt: now,
      input: { keywords },
    })
    log('info', 'lead_analysis.succeeded', { job_id: jobId, tokens_in: analysis.usage.input_tokens, tokens_out: analysis.usage.output_tokens })
    return 'succeeded'
  } catch (err) {
    const code = err instanceof AiError ? err.code : 'internal_error'
    log('warn', 'lead_analysis.failed', { job_id: jobId, code })
    await store.updateAiJob(org, jobId, { status: 'failed', error: code, completedAt: new Date().toISOString(), input: {} }).catch(() => undefined)
    return 'failed'
  }
}
