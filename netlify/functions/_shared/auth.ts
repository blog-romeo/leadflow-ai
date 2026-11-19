import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { HttpError } from './http'

/**
 * Autorizzazione lato server per le Netlify Functions.
 *
 * 1. Verifica il JWT dell'utente con Supabase Auth (non ci si fida del client).
 * 2. Crea un client "per-utente" che inoltra il JWT: tutte le query passano dalle policy RLS.
 * 3. Verifica l'appartenenza (e opzionalmente il ruolo) nell'organizzazione richiesta.
 *
 * La service_role key NON è usata qui: verrà usata solo da job server (AI, webhook Stripe)
 * dopo questi controlli, e solo tramite variabili d'ambiente Netlify.
 */
export interface AuthContext {
  user: User
  db: SupabaseClient
  role: 'organization_admin' | 'member'
}

function serverEnv() {
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_ANON_KEY
  if (!url || !anon) throw new HttpError(503, 'server_not_configured')
  return { url, anon }
}

export async function requireUser(req: Request): Promise<{ user: User; db: SupabaseClient }> {
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) throw new HttpError(401, 'missing_token')
  const { url, anon } = serverEnv()
  const db = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data, error } = await db.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'invalid_token')
  return { user: data.user, db }
}

export async function requireOrgMember(req: Request, organizationId: string, opts: { admin?: boolean } = {}): Promise<AuthContext> {
  const { user, db } = await requireUser(req)
  const { data, error } = await db
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) throw new HttpError(500, 'membership_lookup_failed')
  // Stessa risposta per "org inesistente" e "non membro": nessuna enumerazione.
  if (!data) throw new HttpError(403, 'forbidden')
  const role = data.role as AuthContext['role']
  if (opts.admin && role !== 'organization_admin') throw new HttpError(403, 'forbidden')
  return { user, db, role }
}
