import { SUPABASE_ANON_KEYS, SUPABASE_SERVICE_KEYS, SUPABASE_URL_KEYS } from '../env'
/**
 * Stato delle integrazioni esterne, ricavato SOLO dalla presenza della configurazione.
 * "configured" non significa "funzionante": la verifica reale avviene con i test di
 * accettazione (docs/DEPLOY_NETLIFY.md) e con i dati di monitoraggio (webhook, job, errori).
 * Non restituisce mai valori dei segreti, solo booleani e la modalità Stripe.
 */
export type IntegrationState = 'configured' | 'missing' | 'partial'

export interface IntegrationStatus {
  key: string
  state: IntegrationState
  note?: string
}

const has = (env: Record<string, string | undefined>, k: string) => typeof env[k] === 'string' && env[k]!.trim() !== ''

export function integrationStatus(env: Record<string, string | undefined> = process.env): IntegrationStatus[] {
  const all = (keys: string[]): IntegrationState => (keys.every((k) => has(env, k)) ? 'configured' : keys.some((k) => has(env, k)) ? 'partial' : 'missing')
  // Ogni gruppo è soddisfatto da uno qualsiasi dei nomi alternativi (vedi _shared/env.ts).
  const anyOf = (groups: string[][]): IntegrationState => {
    const ok = groups.filter((g) => g.some((k) => has(env, k))).length
    return ok === groups.length ? 'configured' : ok > 0 ? 'partial' : 'missing'
  }
  const stripeKey = env.STRIPE_SECRET_KEY?.trim() ?? ''
  const stripeMode = stripeKey.startsWith('sk_live_') || stripeKey.startsWith('rk_live_') ? 'live' : stripeKey ? 'test' : 'none'
  return [
    { key: 'supabase', state: anyOf([SUPABASE_URL_KEYS, SUPABASE_ANON_KEYS, SUPABASE_SERVICE_KEYS]) },
    {
      key: 'stripe',
      state: all(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_STARTER', 'STRIPE_PRICE_BUSINESS', 'STRIPE_PRICE_ENTERPRISE']),
      note: stripeMode === 'live' ? (env.STRIPE_LIVE_MODE_APPROVED === 'yes-i-approve-live-payments' ? 'live_approved' : 'live_blocked') : stripeMode,
    },
    { key: 'stripe_tax', state: env.STRIPE_AUTOMATIC_TAX?.trim() === 'true' ? 'configured' : 'missing' },
    { key: 'stripe_white_label', state: all(['STRIPE_PRICE_RESELLER_AGENCY', 'STRIPE_PRICE_RESELLER_AGENCY_SETUP', 'STRIPE_PRICE_RESELLER_PREMIUM', 'STRIPE_PRICE_RESELLER_PREMIUM_SETUP']) },
    { key: 'openai', state: all(['OPENAI_API_KEY', 'OPENAI_MODEL']), note: has(env, 'OPENAI_PRICE_INPUT_PER_MTOK') && has(env, 'OPENAI_PRICE_OUTPUT_PER_MTOK') ? 'cost_tracked' : 'cost_not_configured' },
    { key: 'overpass', state: all(['OVERPASS_API_URL', 'OVERPASS_CONTACT']) },
    { key: 'google_places', state: all(['GOOGLE_PLACES_API_KEY']) },
    { key: 'internal_secret', state: (env.LEADFLOW_INTERNAL_SECRET ?? '').length >= 32 ? 'configured' : 'missing' },
    { key: 'credentials_key', state: all(['LEADFLOW_CREDENTIALS_KEY']) },
    { key: 'platform_notifications', state: all(['PLATFORM_NOTIFY_RESEND_API_KEY', 'PLATFORM_NOTIFY_FROM', 'PLATFORM_NOTIFY_TO']) },
    { key: 'app_url', state: has(env, 'APP_URL') || has(env, 'URL') ? 'configured' : 'missing' },
  ]
}
