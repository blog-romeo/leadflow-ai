import { HttpError } from '../http'
import type { BillingGate, Feature } from './store'

/**
 * Servizio centralizzato di autorizzazione commerciale.
 *
 *   canUseFeature(organizationId, feature)
 *
 * La decisione è presa dal database (private.feature_check: abbonamento corrente letto da
 * Stripe, stato, funzionalità del piano) e applicata lato server negli endpoint. I pulsanti
 * disabilitati nell'interfaccia sono solo un aiuto: la protezione è qui e nei trigger SQL.
 */
export async function canUseFeature(gate: BillingGate, organizationId: string, feature: Feature) {
  return gate.canUseFeature(organizationId, feature)
}

/** Interrompe la richiesta con 402 e un codice stabile (es. billing_feature_not_in_plan). */
export async function requireFeature(gate: BillingGate, organizationId: string, feature: Feature): Promise<void> {
  const d = await gate.canUseFeature(organizationId, feature)
  if (!d.allowed) {
    throw new HttpError(402, `billing_${d.reason}`, { feature, ...(d.plan_code ? { plan_code: d.plan_code } : {}) })
  }
}

const BILLING_CODE = /^(billing|platform)_[a-z_]{3,60}$/

/**
 * Converte gli errori sollevati dai trigger/RPC di billing (messaggio "billing_<motivo>",
 * dettaglio JSON) in HttpError 402. Restituisce null per gli altri errori.
 */
export function billingDbError(error: { message?: string; details?: string | null; code?: string } | null | undefined): HttpError | null {
  const msg = error?.message?.trim() ?? ''
  if (!BILLING_CODE.test(msg)) return null
  let details: Record<string, unknown> = {}
  try {
    const parsed = error?.details ? (JSON.parse(error.details) as Record<string, unknown>) : {}
    for (const k of ['remaining', 'limit', 'credits', 'feature', 'plan_code', 'provider', 'cap_usd', 'spent_usd'] as const) {
      if (parsed[k] !== undefined && parsed[k] !== null) details[k] = parsed[k]
    }
  } catch {
    details = {}
  }
  // platform_*: operazione sospesa dal super admin o limite di spesa → 503 (non è un problema di pagamento).
  return new HttpError(msg.startsWith('platform_') ? 503 : 402, msg, details)
}
