import { HttpError, handleError, json, readJson, requireMethod } from './_shared/http'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { log } from './_shared/log'
import { validateDemo } from './_shared/launch/demo'
import { clientIp, rateKey } from './_shared/launch/hash'
import { notifyPlatform } from './_shared/launch/notify'

/**
 * POST /api/demo — richiesta di demo dal sito pubblico (senza login).
 * Validazione + antispam (honeypot, tempo minimo, limite per IP con hash, limite globale),
 * salvataggio in demo_requests con la service role, notifica interna SOLO se configurata.
 * Non prenota appuntamenti: lo stato "scheduled" lo imposta lo staff dopo aver concordato
 * davvero data e ora con il richiedente (nessun calendario collegato).
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const raw = await readJson(req, 8_000)
    const key = rateKey(clientIp(req), 'demo')
    if (!key) throw new HttpError(503, 'server_not_configured')
    const admin = supabaseAdmin()
    const [perIp, global] = await Promise.all([
      admin.rpc('public_rate_limit', { p_key_hash: key, p_bucket: 'demo', p_max: 5, p_window_minutes: 60 }),
      admin.rpc('public_rate_limit', { p_key_hash: '0'.repeat(64), p_bucket: 'demo_global', p_max: 200, p_window_minutes: 60 }),
    ])
    if (perIp.error || global.error) throw new HttpError(500, 'storage_error')
    if (!perIp.data || !global.data) throw new HttpError(429, 'rate_limited', { retry_after: 3600 })

    const v = validateDemo(raw)
    // Bot: risposta identica a un invio riuscito, senza salvare nulla (non si rivela il filtro).
    if (!v.ok && v.spam) {
      log('info', 'demo.spam_discarded', {})
      return json({ ok: true })
    }
    if (!v.ok) throw new HttpError(400, 'validation_failed', { fields: v.errors })

    const { data, error } = await admin
      .from('demo_requests')
      .insert({ ...v.data, consent_at: new Date().toISOString() })
      .select('id, created_at')
      .single()
    if (error) throw new HttpError(500, 'storage_error')
    const row = data as { id: string; created_at: string }

    const d = v.data
    const result = await notifyPlatform(
      `[LeadFlow AI] Nuova richiesta demo: ${d.company}`,
      [
        `Azienda: ${d.company}`,
        `Referente: ${d.name}`,
        `Email: ${d.email}${v.personalEmail ? ' (email personale)' : ''}`,
        d.phone ? `Telefono: ${d.phone}` : null,
        `Settore: ${d.sector}`,
        d.employees ? `Dipendenti: ${d.employees}` : null,
        `Preferenza di contatto: ${d.contact_preference}`,
        '',
        d.message,
        '',
        'Gestisci la richiesta nella console: /super-admin/demo',
      ].filter((l) => l !== null).join('\n'),
    )
    await admin
      .from('demo_requests')
      .update(result.sent ? { notified_at: new Date().toISOString(), notification_error: null } : { notification_error: result.reason })
      .eq('id', row.id)
    log('info', 'demo.received', { notified: result.sent })
    return json({ ok: true }, 201)
  } catch (err) {
    return handleError(err, '/api/demo')
  }
}
export const config = { path: '/api/demo' }
