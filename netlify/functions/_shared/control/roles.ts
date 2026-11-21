import type { SupabaseClient, User } from '@supabase/supabase-js'
import { HttpError } from '../http'
import { requireUser } from '../auth'
import { rpc } from './rpc'

/**
 * Controlli di ruolo lato server per ogni endpoint della console. Sono una prima barriera:
 * le RPC chiamate con il JWT dell'utente verificano di nuovo il ruolo nel database.
 */
export async function requireSuperAdmin(req: Request): Promise<{ user: User; db: SupabaseClient }> {
  const { user, db } = await requireUser(req)
  const { data, error } = await db.from('profiles').select('platform_role').eq('id', user.id).maybeSingle()
  if (error) throw new HttpError(500, 'profile_lookup_failed')
  if (data?.platform_role !== 'super_admin') throw new HttpError(403, 'forbidden')
  return { user, db }
}

export interface ResellerMembership {
  id: string
  name: string
  role: 'reseller_admin' | 'reseller_member'
  status: 'active' | 'suspended'
}

export async function requireResellerMember(
  req: Request,
  resellerId: string,
  opts: { admin?: boolean } = {},
): Promise<{ user: User; db: SupabaseClient; membership: ResellerMembership }> {
  const { user, db } = await requireUser(req)
  const list = await rpc<ResellerMembership[]>(db, 'reseller_my_resellers')
  const membership = list.find((r) => r.id === resellerId)
  // Stessa risposta per rivenditore inesistente o non proprio: nessuna enumerazione.
  if (!membership) throw new HttpError(403, 'forbidden')
  if (opts.admin && membership.role !== 'reseller_admin') throw new HttpError(403, 'forbidden')
  return { user, db, membership }
}
