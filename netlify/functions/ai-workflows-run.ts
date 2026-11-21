import { timingSafeInternal } from './_shared/internalAuth'
import { log } from './_shared/log'
import { runWorkflow } from './_shared/agents/engine'
import { agentEngineDeps } from './_shared/agents/deps'

/**
 * Background function: esegue (o riprende) un workflow. Invocabile solo con il segreto interno.
 * Il lease nel database impedisce esecuzioni concorrenti dello stesso workflow.
 */
export default async (req: Request): Promise<void> => {
  if (req.method !== 'POST' || !timingSafeInternal(req)) {
    log('warn', 'ai_workflow.unauthorized_run')
    return
  }
  let id = ''
  try {
    const body = (await req.json()) as { workflow_id?: unknown }
    id = typeof body.workflow_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.workflow_id) ? body.workflow_id : ''
  } catch {
    /* ignorato */
  }
  if (!id) return
  try {
    const r = await runWorkflow(agentEngineDeps(req.url), id)
    log('info', 'ai_workflow.run', { workflow_id: id, status: r.status })
  } catch (err) {
    // Il lease scade e la function pianificata riprende il workflow.
    log('error', 'ai_workflow.run_failed', { workflow_id: id, message: (err as Error)?.message?.slice(0, 160) })
  }
}

export const config = { path: '/api/ai-workflows/run', background: true }
