import { handleError, json, readJson, requireMethod } from './_shared/http'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { reportError } from './_shared/monitoring'
import { clientIp, rateKey } from './_shared/launch/hash'

/**
 * POST /api/monitoring/client-error { code, message, path, release } — errori JavaScript del browser.
 * Dati tecnici minimi, sanificati lato server (email, ID, numeri, token e query string rimossi)
 * e aggregati per impronta: necessari al funzionamento e alla sicurezza del servizio.
 * Limite: 30 segnalazioni all'ora per IP (hash) per evitare abusi.
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const b = (await readJson(req, 4_000)) as Record<string, unknown>
    const key = rateKey(clientIp(req), 'client_error')
    if (!key || !b || typeof b !== 'object') return json({ ok: true }, 202)
    const { data: ok } = await supabaseAdmin().rpc('public_rate_limit', { p_key_hash: key, p_bucket: 'client_error', p_max: 30, p_window_minutes: 60 })
    if (!ok) return json({ ok: true }, 202)
    const code = typeof b.code === 'string' && b.code ? b.code : 'Error'
    await reportError({ source: 'client', code, message: typeof b.message === 'string' ? b.message : undefined, path: b.path, release: typeof b.release === 'string' ? b.release : null })
    return json({ ok: true }, 202)
  } catch (err) {
    return handleError(err)
  }
}
export const config = { path: '/api/monitoring/client-error' }
