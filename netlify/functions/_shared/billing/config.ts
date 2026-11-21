/**
 * Configurazione Stripe lato server (solo variabili d'ambiente Netlify, mai VITE_).
 *
 * Sicurezza della modalità:
 * • in sviluppo si usano SOLO chiavi di test (sk_test_ / rk_test_);
 * • una chiave live viene rifiutata finché STRIPE_LIVE_MODE_APPROVED non vale esattamente
 *   "yes-i-approve-live-payments": il passaggio a Stripe Live richiede una scelta esplicita.
 */
export const PLAN_CODES = ['starter', 'business', 'enterprise'] as const
export type PlanCode = (typeof PLAN_CODES)[number]

export const LIVE_APPROVAL_VALUE = 'yes-i-approve-live-payments'
/** Versione API Stripe fissata: le risposte hanno sempre la stessa forma (sovrascrivibile). */
export const DEFAULT_STRIPE_API_VERSION = '2025-03-31.basil'

export type StripeMode = 'test' | 'live'

export interface StripeConfig {
  secretKey: string
  webhookSecret: string | null
  mode: StripeMode
  apiVersion: string
  /** Price ID per piano da variabili d'ambiente (STRIPE_PRICE_<CODE>). */
  envPrices: Partial<Record<PlanCode, string>>
  /** Price ID dei piani White Label (STRIPE_PRICE_RESELLER_<CODE> e STRIPE_PRICE_RESELLER_<CODE>_SETUP). */
  envResellerPrices: Partial<Record<ResellerPlanCode, { monthly?: string; setup?: string }>>
  appUrl: string
  /**
   * STRIPE_AUTOMATIC_TAX=true → Stripe Tax calcola l'IVA in Checkout (automatic_tax). Richiede Stripe Tax
   * attivo con la registrazione fiscale nel Dashboard: lasciarlo spento finché non è configurato,
   * altrimenti Stripe rifiuta la creazione della sessione. Spento = nessuna IVA calcolata da Stripe.
   */
  automaticTax?: boolean
}

export const RESELLER_PLAN_CODES = ['agency', 'premium'] as const
export type ResellerPlanCode = (typeof RESELLER_PLAN_CODES)[number]

export interface StripeConfigState {
  configured: boolean
  mode: StripeMode | null
  missing: string[]
  /** Problemi bloccanti (es. chiave live senza approvazione). Nessun segreto incluso. */
  blocked: string[]
  webhook_configured: boolean
  prices_configured: PlanCode[]
}

function keyMode(key: string): StripeMode | null {
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) return 'test'
  if (/^(sk|rk)_live_[A-Za-z0-9]+$/.test(key)) return 'live'
  return null
}

export function readStripeConfig(env: NodeJS.ProcessEnv = process.env): { config: StripeConfig | null; state: StripeConfigState } {
  const missing: string[] = []
  const blocked: string[] = []
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? ''
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || null
  if (!secretKey) missing.push('STRIPE_SECRET_KEY')
  const mode = secretKey ? keyMode(secretKey) : null
  if (secretKey && !mode) blocked.push('stripe_secret_key_invalid_format')
  if (mode === 'live' && env.STRIPE_LIVE_MODE_APPROVED !== LIVE_APPROVAL_VALUE) blocked.push('stripe_live_mode_not_approved')
  const publishable = env.STRIPE_PUBLISHABLE_KEY?.trim()
  if (publishable && mode && !publishable.startsWith(`pk_${mode}_`)) blocked.push('stripe_publishable_key_mode_mismatch')
  if (webhookSecret && !webhookSecret.startsWith('whsec_')) blocked.push('stripe_webhook_secret_invalid_format')

  const envPrices: Partial<Record<PlanCode, string>> = {}
  for (const code of PLAN_CODES) {
    const v = env[`STRIPE_PRICE_${code.toUpperCase()}`]?.trim()
    if (v) {
      if (/^price_[A-Za-z0-9]{6,}$/.test(v)) envPrices[code] = v
      else blocked.push(`stripe_price_${code}_invalid_format`)
    }
  }
  const envResellerPrices: StripeConfig['envResellerPrices'] = {}
  for (const code of RESELLER_PLAN_CODES) {
    const entry: { monthly?: string; setup?: string } = {}
    for (const [key, field] of [[`STRIPE_PRICE_RESELLER_${code.toUpperCase()}`, 'monthly'], [`STRIPE_PRICE_RESELLER_${code.toUpperCase()}_SETUP`, 'setup']] as const) {
      const v = env[key]?.trim()
      if (!v) continue
      if (/^price_[A-Za-z0-9]{6,}$/.test(v)) entry[field] = v
      else blocked.push(`${key.toLowerCase()}_invalid_format`)
    }
    if (entry.monthly || entry.setup) envResellerPrices[code] = entry
  }
  const appUrl = (env.APP_URL || env.URL || env.VITE_APP_URL || '').replace(/\/+$/, '')
  if (!appUrl) missing.push('URL')

  const state: StripeConfigState = {
    configured: missing.length === 0 && blocked.length === 0,
    mode,
    missing,
    blocked,
    webhook_configured: Boolean(webhookSecret) && !blocked.includes('stripe_webhook_secret_invalid_format'),
    prices_configured: PLAN_CODES.filter((c) => envPrices[c]),
  }
  if (!state.configured || !mode) return { config: null, state }
  return {
    config: { secretKey, webhookSecret, mode, apiVersion: env.STRIPE_API_VERSION?.trim() || DEFAULT_STRIPE_API_VERSION, envPrices, envResellerPrices, appUrl, automaticTax: env.STRIPE_AUTOMATIC_TAX?.trim() === 'true' },
    state,
  }
}
