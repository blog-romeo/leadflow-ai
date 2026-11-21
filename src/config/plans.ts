/**
 * Configurazione commerciale pubblica: UNICA fonte per landing, pagina prezzi e onboarding.
 * Deve coincidere con i dati seminati in supabase/migrations/20261122000007_billing.sql
 * (tabella billing_plans, usata da Stripe Checkout e dai controlli di accesso) e
 * 20261123000008_control_center_white_label.sql (reseller_plans): il test plans.test.ts
 * confronta i valori. Il prezzo effettivo addebitato è quello del Price ID Stripe configurato.
 * Se il super admin aggiorna un piano, /api/pricing restituisce i valori aggiornati.
 */
export type PlanCode = 'starter' | 'business' | 'enterprise'
export type PlanFeature =
  | 'lead_finder'
  | 'ai_analyzer'
  | 'ai_sales_agent'
  | 'campaign_manager'
  | 'crm_advanced'
  | 'export'
  | 'automations'
  | 'advanced_analytics'
  | 'priority_support'

export interface PublicPlan {
  code: PlanCode
  name: string
  priceCents: number
  monthlyLeads: number
  monthlyAiCredits: number
  maxUsers: number
  features: PlanFeature[]
  highlighted?: boolean
}

export const CURRENCY = 'EUR'
/** Prezzi esposti IVA esclusa (clientela B2B). Aliquota applicata in fattura secondo la normativa. */
export const VAT_INCLUDED = false
export const VAT_RATE_IT = 22

export const PLANS: PublicPlan[] = [
  { code: 'starter', name: 'Starter', priceCents: 14900, monthlyLeads: 250, monthlyAiCredits: 500, maxUsers: 1, features: ['lead_finder', 'ai_analyzer', 'export'] },
  {
    code: 'business',
    name: 'Business',
    priceCents: 34900,
    monthlyLeads: 1000,
    monthlyAiCredits: 2500,
    maxUsers: 5,
    features: ['lead_finder', 'ai_analyzer', 'ai_sales_agent', 'campaign_manager', 'crm_advanced', 'export'],
    highlighted: true,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    priceCents: 79900,
    monthlyLeads: 5000,
    monthlyAiCredits: 10000,
    maxUsers: 20,
    features: ['lead_finder', 'ai_analyzer', 'ai_sales_agent', 'campaign_manager', 'crm_advanced', 'export', 'automations', 'advanced_analytics', 'priority_support'],
  },
]

export const PLAN_FEATURE_ORDER: PlanFeature[] = [
  'lead_finder', 'ai_analyzer', 'export', 'ai_sales_agent', 'campaign_manager', 'crm_advanced', 'automations', 'advanced_analytics', 'priority_support',
]

export interface ResellerPlan {
  code: 'agency' | 'premium'
  name: string
  setupFeeCents: number
  monthlyPriceCents: number
  maxOrganizations: number
  maxCustomDomains: number
}

export const RESELLER_PLANS: ResellerPlan[] = [
  { code: 'agency', name: 'Agency', setupFeeCents: 299000, monthlyPriceCents: 39900, maxOrganizations: 25, maxCustomDomains: 1 },
  { code: 'premium', name: 'Premium', setupFeeCents: 599000, monthlyPriceCents: 79900, maxOrganizations: 100, maxCustomDomains: 10 },
]

/** Sovrascrive i valori locali con quelli del server (/api/pricing), se presenti e coerenti. */
export function mergeServerPlans(
  local: PublicPlan[],
  server: { code: string; name: string; price_cents: number; monthly_leads: number; monthly_ai_credits: number; max_users: number; features: string[] }[] | null,
): PublicPlan[] {
  if (!server) return local
  return local
    .filter((p) => server.some((s) => s.code === p.code))
    .map((p) => {
      const s = server.find((x) => x.code === p.code)!
      return {
        ...p,
        name: s.name,
        priceCents: s.price_cents,
        monthlyLeads: s.monthly_leads,
        monthlyAiCredits: s.monthly_ai_credits,
        maxUsers: s.max_users,
        features: s.features.filter((f): f is PlanFeature => (PLAN_FEATURE_ORDER as string[]).includes(f)),
      }
    })
}

export function formatEuro(cents: number, locale: 'it' | 'en'): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-IE' : 'it-IT', { style: 'currency', currency: CURRENCY, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100)
}

/** Piano scelto nella pagina prezzi prima della registrazione (preferenza tecnica locale). */
export const SIGNUP_PLAN_KEY = 'lf-signup-plan'
