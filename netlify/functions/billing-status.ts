import { handleError, json, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { readStripeConfig } from './_shared/billing/config'
import { priceIdForPlan, type PlanRow } from './_shared/billing/mapping'

/**
 * GET /api/billing/status?organization_id=<uuid>
 * Piano, stato, periodo, crediti e lead del periodo, catalogo piani, costi in crediti e,
 * per gli admin, lo storico fatture. Tutte le letture passano dalle policy RLS dell'utente.
 */
export default async (req: Request): Promise<Response> => {
  try {
    if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
    const orgId = requireUuid(new URL(req.url).searchParams.get('organization_id'), 'organization_id')
    const { db, role } = await requireOrgMember(req, orgId)
    const { config, state } = readStripeConfig()

    const [status, plans, costs, invoices] = await Promise.all([
      db.rpc('billing_status', { p_org: orgId }),
      db.from('billing_plans').select('code, name, description, price_cents, currency, stripe_price_id, monthly_leads, monthly_ai_credits, max_users, features, is_active, sort_order').order('sort_order'),
      db.from('ai_credit_costs').select('operation, credits, feature, description').order('credits'),
      role === 'organization_admin'
        ? db.from('billing_invoices')
            .select('stripe_invoice_id, number, status, currency, total_cents, total_excluding_tax_cents, amount_paid_cents, amount_remaining_cents, period_start, period_end, paid_at, hosted_invoice_url, invoice_pdf, stripe_created_at, livemode')
            .eq('organization_id', orgId)
            .order('stripe_created_at', { ascending: false })
            .limit(24)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (status.error || plans.error || costs.error || invoices.error) return json({ error: 'storage_error' }, 500)

    // Piani acquistabili (attivi) + il piano corrente anche se non in vendita (es. beta gratuita del Prompt 13).
    const currentCode = (status.data as { subscription?: { plan_code?: string | null } } | null)?.subscription?.plan_code ?? null
    return json({
      ...(status.data as Record<string, unknown>),
      plans: ((plans.data ?? []) as (PlanRow & { description: string | null })[]).filter((p) => p.is_active || p.code === currentCode).map(({ stripe_price_id, ...p }) => ({
        ...p,
        purchasable: Boolean(config && priceIdForPlan({ code: p.code, stripe_price_id }, config.envPrices)),
      })),
      credit_costs: costs.data ?? [],
      invoices: invoices.data ?? [],
      // Stato della configurazione senza segreti: solo modalità e cosa manca.
      stripe: { configured: state.configured, mode: state.mode, webhook_configured: state.webhook_configured, missing: role === 'organization_admin' ? state.missing : [], blocked: role === 'organization_admin' ? state.blocked : [] },
    })
  } catch (err) {
    return handleError(err)
  }
}
export const config = { path: '/api/billing/status' }
