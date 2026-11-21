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
import { log } from '../log'
import { DEFAULT_BLOCKING, type ReviewCode } from './reviewer'

const REVIEW_CODES: ReviewCode[] = ['format_error', 'unsourced_fact', 'claim_not_verified', 'incomplete_output', 'duplicate_ids', 'duplicate_content', 'contradiction', 'strategy_unsupported']

/**
 * Prompt 12: codici bloccanti del Quality Reviewer dalla versione di configurazione ATTIVA (approvata dal
 * Super Admin con benchmark). Valori sconosciuti scartati; in caso di errore si usa il default sicuro.
 */
export async function loadReviewerBlocking(): Promise<readonly ReviewCode[]> {
  try {
    const { data, error } = await supabaseAdmin().rpc('ai_active_config', { p_config_key: 'quality_reviewer.blocking_codes' })
    const codes = (data as { blocking_codes?: unknown } | null)?.blocking_codes
    if (error || !Array.isArray(codes)) return DEFAULT_BLOCKING
    return codes.filter((c): c is ReviewCode => REVIEW_CODES.includes(c as ReviewCode))
  } catch (err) {
    log('warn', 'ai_config.load_failed', { message: (err as Error)?.message?.slice(0, 120) })
    return DEFAULT_BLOCKING
  }
}

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
