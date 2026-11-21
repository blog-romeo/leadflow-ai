import { supabaseAdmin } from './_shared/supabaseAdmin'
import { dispatchBackground } from './_shared/dispatch'
import { log } from './_shared/log'
import { agentsFlag } from './_shared/agents/flags'
import { createAgentStore } from './_shared/agents/supabaseStore'

/**
 * Scheduled function (ogni 5 minuti): scade le approvazioni oltre il termine e riprende i workflow
 * "pending" o "running" con lease scaduto (invocazione interrotta). Non fa nulla con il flag spento.
 * Non elimina dati.
 */
export default async (): Promise<void> => {
  if (!agentsFlag().enabled) return
  try {
    const store = createAgentStore(supabaseAdmin())
    const expired = await store.expireApprovals()
    const ids = [...new Set([...expired, ...(await store.listResumable(10))])].slice(0, 10)
    const base = process.env.URL ?? ''
    if (!base) {
      log('warn', 'ai_workflow_tick.no_url', {})
      return
    }
    for (const id of ids) await dispatchBackground('/api/ai-workflows/run', base, { workflow_id: id })
    if (ids.length || expired.length) log('info', 'ai_workflow_tick', { resumed: ids.length, expired_approvals: expired.length })
  } catch (err) {
    log('error', 'ai_workflow_tick.failed', { message: (err as Error)?.message?.slice(0, 160) })
  }
}

export const config = { schedule: '*/5 * * * *' }
