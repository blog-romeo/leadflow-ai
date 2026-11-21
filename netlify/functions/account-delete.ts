import { HttpError, handleError, json, readJson, requireMethod } from './_shared/http'
import { requireUser } from './_shared/auth'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { log } from './_shared/log'

/**
 * POST /api/account/delete { confirm_email } — Cancellazione self-service dell'account (REL-47).
 * 1. public.account_delete_self con il JWT dell'utente: verifica conferma, ultimo amministratore,
 *    abbonamenti a pagamento; rimuove le membership e disattiva le organizzazioni di cui era l'unico membro.
 * 2. Eliminazione dell'utente in Supabase Auth con la service role (il profilo segue in cascata).
 * Se il passo 2 fallisce l'utente non ha più accesso ad alcuna organizzazione e può ripetere la richiesta.
 */
const KNOWN = new Set(['confirmation_mismatch', 'last_admin', 'paid_subscription_active', 'super_admin_cannot_self_delete', 'reseller_admin_cannot_self_delete'])

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const body = (await readJson(req, 2_000)) as Record<string, unknown>
    const confirm = typeof body?.confirm_email === 'string' ? body.confirm_email.trim().slice(0, 320) : ''
    if (!confirm) throw new HttpError(400, 'confirmation_mismatch')
    const { user, db } = await requireUser(req)

    const { data, error } = await db.rpc('account_delete_self', { p_confirm: confirm })
    if (error) {
      const code = [...KNOWN].find((k) => error.message?.includes(k))
      if (code) throw new HttpError(code === 'confirmation_mismatch' ? 400 : 409, code)
      throw new HttpError(500, 'storage_error')
    }
    const { error: authErr } = await supabaseAdmin().auth.admin.deleteUser(user.id)
    if (authErr) {
      log('error', 'account_delete.auth_failed', {})
      throw new HttpError(502, 'auth_delete_failed')
    }
    log('info', 'account_delete.done', { organizations_deactivated: (data as { organizations_deactivated?: number })?.organizations_deactivated ?? 0 })
    return json({ ok: true, ...(data as object) })
  } catch (err) {
    return handleError(err, '/api/account/delete')
  }
}
export const config = { path: '/api/account/delete' }
