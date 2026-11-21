import { HttpError } from '../http'
import { supabaseAdmin } from '../supabaseAdmin'
import { readStripeConfig } from './config'
import { createStripeGateway } from './stripeClient'
import { createBillingGate, createBillingStore } from './supabaseStore'
import type { BillingDeps } from './service'

/** Dipendenze di produzione. 503 se Stripe non è configurato (o live non approvato). */
export function billingDeps(env: NodeJS.ProcessEnv = process.env): BillingDeps {
  const { config, state } = readStripeConfig(env)
  if (!config) throw new HttpError(503, 'billing_not_configured', { missing: state.missing, blocked: state.blocked })
  return { store: createBillingStore(supabaseAdmin()), stripe: createStripeGateway(config), config }
}

/** Gate funzionalità/quote (non richiede Stripe: legge lo stato salvato dai webhook). */
export function billingGate() {
  return createBillingGate(supabaseAdmin())
}
