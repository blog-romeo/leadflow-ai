import { supabaseUrl, supabaseServiceKey } from './_shared/env'
import { json } from './_shared/http'
import { log } from './_shared/log'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { requestHostname, toPublicBranding } from './_shared/control/tenant'

/**
 * GET /api/tenant — branding White Label per l'hostname della richiesta (pubblico, senza login).
 * L'hostname è quello con cui il browser ha raggiunto il server, non un parametro del client.
 * Solo domini ATTIVI (verificati, CNAME corretto, alias configurato, HTTPS raggiungibile) di
 * rivenditori attivi applicano un branding; in tutti gli altri casi { tenant: null }.
 */
export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
  const headers = { 'cache-control': 'public, max-age=300', vary: 'Host' }
  const host = requestHostname(req)
  if (!host || !supabaseUrl() || !supabaseServiceKey()) return json({ tenant: null }, 200, headers)
  try {
    const { data, error } = await supabaseAdmin().rpc('tenant_by_hostname', { p_hostname: host })
    if (error) throw error
    const t = data as { reseller_id: string; branding: Record<string, unknown> | null } | null
    if (!t) return json({ tenant: null }, 200, headers)
    return json({ tenant: toPublicBranding(t.reseller_id, t.branding, supabaseUrl()) }, 200, headers)
  } catch {
    log('warn', 'tenant.lookup_failed', {})
    // In caso di errore si mostra il marchio predefinito: nessun dato di altri tenant.
    return json({ tenant: null }, 200, { 'cache-control': 'no-store' })
  }
}
export const config = { path: '/api/tenant' }
