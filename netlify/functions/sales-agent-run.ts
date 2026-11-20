import { runSalesJob } from './_shared/sales-agent/service'
import { salesDeps } from './_shared/sales-agent/deps'
import { timingSafeInternal } from './_shared/internalAuth'
import { log } from './_shared/log'

/** Background function: esegue un job del Sales Agent. Invocabile solo con il segreto interno. */
export default async (req: Request): Promise<void> => {
  if (req.method !== 'POST' || !timingSafeInternal(req)) {
    log('warn', 'sales_job.unauthorized_run')
    return
  }
  let jobId = ''
  try {
    const body = (await req.json()) as { job_id?: unknown }
    jobId = typeof body.job_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.job_id) ? body.job_id : ''
  } catch {
    /* ignorato */
  }
  if (jobId) await runSalesJob({ store: salesDeps().store }, jobId)
}

export const config = { path: '/api/sales-agent/run', background: true }
