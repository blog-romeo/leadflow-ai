import { supabaseUrl, supabaseServiceKey } from './_shared/env'
import { json } from './_shared/http'
import { supabaseAdmin } from './_shared/supabaseAdmin'

/**
 * GET /api/pricing — piani attivi letti da billing_plans (stessa fonte usata da Stripe Checkout
 * e dai controlli di accesso). Il sito mostra subito i valori di src/config/plans.ts e li
 * sostituisce con questi se diversi (es. prezzo aggiornato dal super admin).
 */
export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
  if (!supabaseUrl() || !supabaseServiceKey()) return json({ plans: null }, 200)
  const { data, error } = await supabaseAdmin()
    .from('billing_plans')
    .select('code, name, price_cents, currency, monthly_leads, monthly_ai_credits, max_users, features')
    .eq('is_active', true)
    .order('sort_order')
  if (error) return json({ plans: null }, 200, { 'cache-control': 'no-store' })
  return json({ plans: data }, 200, { 'cache-control': 'public, max-age=300' })
}
export const config = { path: '/api/pricing' }
