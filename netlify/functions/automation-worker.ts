import { randomUUID } from 'node:crypto'
import { campaignDeps } from './_shared/campaigns/deps'
import { runWorker } from './_shared/campaigns/worker'
import { timingSafeInternal } from './_shared/internalAuth'
import { log } from './_shared/log'

/** Background function: elabora i job di automazione. Invocabile solo con il segreto interno. */
export default async (req: Request): Promise<void> => {
  if (req.method !== 'POST' || !timingSafeInternal(req)) {
    log('warn', 'automation.unauthorized_worker')
    return
  }
  const workerId = `w-${randomUUID().slice(0, 8)}`
  const r = await runWorker(campaignDeps(), { workerId, budgetMs: 13 * 60_000 })
  log('info', 'automation.worker_done', { worker: workerId, ...r })
}

export const config = { path: '/api/automation/worker', background: true }
