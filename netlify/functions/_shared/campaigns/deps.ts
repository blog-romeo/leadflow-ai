import { supabaseAdmin } from '../supabaseAdmin'
import { dispatchBackground } from '../dispatch'
import { createSalesStore } from '../sales-agent/supabaseStore'
import { requestSalesJob } from '../sales-agent/service'
import { aiMissingConfig } from '../lead-finder/analysisService'
import { providerRegistry } from './providers/registry'
import { createAccountsDb, createCampaignStore } from './supabaseStore'
import type { WorkerDeps } from './worker'

const baseUrl = () => process.env.URL ?? 'http://localhost:8888'

/** Dipendenze di produzione (service role) del Campaign Manager. */
export function campaignDeps() {
  const db = supabaseAdmin()
  const store = createCampaignStore(db)
  const sales = createSalesStore(db)

  // Le generazioni AI avviate dal motore usano quote e limiti dell'organizzazione e sono
  // attribuite a una persona (chi ha attivato la campagna/workflow o un admin).
  async function startAi(org: string, userId: string, input: Parameters<typeof requestSalesJob>[2]) {
    if (aiMissingConfig().length) return
    const { job_id } = await requestSalesJob({ store: sales }, { orgId: org, userId }, input)
    await dispatchBackground('/api/sales-agent/run', baseUrl(), { job_id })
  }
  async function anyAdmin(org: string): Promise<string | null> {
    const { data } = await db.from('organization_members').select('user_id').eq('organization_id', org).eq('role', 'organization_admin').order('created_at').limit(1)
    return (data?.[0]?.user_id as string | undefined) ?? null
  }

  const deps: WorkerDeps & { accounts: ReturnType<typeof createAccountsDb> } = {
    store,
    accounts: createAccountsDb(db),
    providers: providerRegistry(),
    requestFollowUpAi: (org, userId, taskId) => startAi(org, userId, { task: 'follow_up_suggestion', follow_up_task_id: taskId }),
    requestInboundAnalysis: async (org, inboundId) => {
      const admin = await anyAdmin(org)
      if (admin) await startAi(org, admin, { task: 'inbound_analysis', inbound_id: inboundId })
    },
    requestDraft: (org, userId, leadId, channel) =>
      startAi(org, userId, { task: 'messages', lead_id: leadId, channel: (['email', 'linkedin', 'whatsapp', 'phone_script', 'follow_up'].includes(channel) ? channel : 'email') as 'email' }),
  }
  return deps
}

export function dispatchWorker() {
  return dispatchBackground('/api/automation/worker', baseUrl(), { reason: 'tick' })
}
