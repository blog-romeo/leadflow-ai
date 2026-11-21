import { handleError, json, readJson, requireMethod } from './_shared/http'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { clientIp, rateKey } from './_shared/launch/hash'

/**
 * POST /api/events { event, anonymous_id, page, consent: true } — statistiche del sito pubblico.
 * Inviato dal browser SOLO dopo il consenso alle statistiche (banner cookie). Il server
 * scarta comunque l'evento se manca il flag di consenso o se il browser segnala Global
 * Privacy Control (Sec-GPC: 1). Nessun cookie, nessun IP salvato, nessun dato personale:
 * un id casuale generato nel browser, il nome dell'evento e il percorso della pagina.
 * Gli eventi degli utenti registrati (registrazione, onboarding, pagamento, attivazione)
 * sono invece generati dal database e non dipendono dal browser.
 */
const EVENTS = new Set(['landing_visit', 'pricing_viewed', 'signup_started'])

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const b = (await readJson(req, 2_000)) as Record<string, unknown>
    const accepted = { ok: true }
    if (!b || b.consent !== true || req.headers.get('sec-gpc') === '1') return json(accepted, 202)
    const event = typeof b.event === 'string' ? b.event : ''
    const anon = typeof b.anonymous_id === 'string' ? b.anonymous_id : ''
    if (!EVENTS.has(event) || !/^[0-9a-f]{32}$/.test(anon)) return json({ error: 'invalid_event' }, 400)
    const key = rateKey(clientIp(req), 'events')
    if (!key) return json(accepted, 202)
    const admin = supabaseAdmin()
    const { data: ok } = await admin.rpc('public_rate_limit', { p_key_hash: key, p_bucket: 'events', p_max: 120, p_window_minutes: 60 })
    if (!ok) return json(accepted, 202)
    const page = typeof b.page === 'string' ? b.page.slice(0, 80) : null
    await admin.rpc('track_public_event', { p_event: event, p_anonymous_id: anon, p_page: page })
    return json(accepted, 202)
  } catch (err) {
    return handleError(err, '/api/events')
  }
}
export const config = { path: '/api/events' }
