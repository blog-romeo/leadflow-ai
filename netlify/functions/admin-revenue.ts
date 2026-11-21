import { HttpError, handleError, json } from './_shared/http'
import { requireUser } from './_shared/auth'

/**
 * GET /api/admin/revenue?days=30 — Revenue Analytics (solo super admin).
 * La funzione SQL verifica il ruolo e restituisce solo aggregati: nessun dato commerciale dei tenant.
 */
export default async (req: Request): Promise<Response> => {
  try {
    if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
    const days = Number(new URL(req.url).searchParams.get('days') ?? '30')
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new HttpError(400, 'invalid_days')
    const { db } = await requireUser(req)
    const { data, error } = await db.rpc('billing_admin_revenue', { p_days: days })
    if (error) throw new HttpError(error.code === '42501' ? 403 : 500, error.code === '42501' ? 'forbidden' : 'storage_error')
    return json(data)
  } catch (err) {
    return handleError(err)
  }
}
export const config = { path: '/api/admin/revenue' }
