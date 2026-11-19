import { timingSafeEqual } from 'node:crypto'
import { runAnalysisJob } from './_shared/lead-finder/analysisService'
import { leadFinderDeps } from './_shared/lead-finder/deps'
import { log } from './_shared/log'

/**
 * Background function (fino a 15 minuti): esegue un job di analisi AI.
 * Invocabile solo dal server con il segreto interno; nessun input utente diretto.
 */
function authorized(req: Request): boolean {
  const expected = process.env.LEADFLOW_INTERNAL_SECRET ?? ''
  const got = req.headers.get('x-leadflow-internal') ?? ''
  if (expected.length < 32 || got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

export default async (req: Request): Promise<void> => {
  if (req.method !== 'POST' || !authorized(req)) {
    log('warn', 'lead_analysis.unauthorized_run')
    return
  }
  let jobId = ''
  try {
    const body = (await req.json()) as { job_id?: unknown }
    jobId = typeof body.job_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.job_id) ? body.job_id : ''
  } catch {
    /* ignorato */
  }
  if (!jobId) return
  await runAnalysisJob({ store: leadFinderDeps().store }, jobId)
}

export const config = { path: '/api/lead-finder/analyze-run', background: true }
