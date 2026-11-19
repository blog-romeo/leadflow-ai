import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { HttpError } from './http'

/**
 * Client con service_role: bypassa RLS. Usato SOLO nelle Netlify Functions e
 * SOLO dopo aver verificato utente, organizzazione e ruolo (vedi auth.ts).
 * La chiave non ha prefisso VITE_ e non può finire nel bundle del browser.
 */
let cached: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new HttpError(503, 'server_not_configured')
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return cached
}
