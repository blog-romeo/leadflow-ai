import { supabaseAdmin } from '../supabaseAdmin'
import { createBillingGate } from '../billing/supabaseStore'
import { requireFeature } from '../billing/access'
import { HttpError } from '../http'
import { requireOrgMember } from '../auth'
import { readDemandHunterConfig } from './config'
import { createServiceClient } from './gateway'
import { createDemandHunterStore } from './supabaseStore'
import type { DhDeps } from './services'
import type { Ctx } from './types'

/** Dipendenze di produzione. Il servizio Python è facoltativo: senza configurazione il modulo lo dice (503). */
export function demandHunterDeps(env: NodeJS.ProcessEnv = process.env): DhDeps & { configMissing: string[]; enabled: boolean } {
  const db = supabaseAdmin()
  const state = readDemandHunterConfig(env)
  const billing = createBillingGate(db)
  return {
    store: createDemandHunterStore(db),
    service: state.config ? createServiceClient(state.config) : null,
    billing: { countNewLeads: (o, u, r, m) => billing.countNewLeads(o, u, r, m), recordProviderCall: (o, u, p, k) => billing.recordProviderCall(o, u, p, k) },
    configMissing: [...state.missing, ...state.invalid],
    enabled: state.enabled,
  }
}

/**
 * Autorizzazione di ogni endpoint: utente autenticato, membro dell'organizzazione, piano con il Lead Finder
 * (Demand Hunter è una fonte di lead del Lead Finder: nessuna nuova voce di listino, nessuna modifica a Stripe).
 */
export async function authorize(req: Request, organizationId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ctx: Ctx; deps: ReturnType<typeof demandHunterDeps> }> {
  const { user } = await requireOrgMember(req, organizationId)
  const deps = demandHunterDeps(env)
  if (!deps.enabled) throw new HttpError(503, 'demand_hunter_disabled')
  await requireFeature(createBillingGate(supabaseAdmin()), organizationId, 'lead_finder')
  return { ctx: { orgId: organizationId, userId: user.id }, deps }
}
