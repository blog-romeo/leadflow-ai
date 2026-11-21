import { supabaseAdmin } from '../supabaseAdmin'
import { createBillingGate } from '../billing/supabaseStore'
import { createSupabaseStore } from '../lead-finder/supabaseStore'
import { createRegistry } from '../lead-finder/providers/registry'
import { createSalesStore } from '../sales-agent/supabaseStore'
import { dispatchBackground } from '../dispatch'
import { HANDLERS } from './handlers'
import { createAgentStore } from './supabaseStore'
import type { EngineDeps } from './engine'
import type { ServiceDeps } from './service'

/** Dipendenze di produzione (service role: usate solo dopo i controlli di autorizzazione). */
export function agentServiceDeps(): ServiceDeps {
  const db = supabaseAdmin()
  return { store: createAgentStore(db), sales: createSalesStore(db), registry: createRegistry(), billing: createBillingGate(db) }
}

export function agentEngineDeps(reqUrl: string): EngineDeps {
  const db = supabaseAdmin()
  return {
    store: createAgentStore(db),
    services: { leadFinder: createSupabaseStore(db), sales: createSalesStore(db), registry: createRegistry(), billing: createBillingGate(db) },
    handlers: HANDLERS,
    continueLater: (id) => dispatchBackground('/api/ai-workflows/run', reqUrl, { workflow_id: id }),
  }
}
