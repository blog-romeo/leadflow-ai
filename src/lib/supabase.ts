import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env'
import type { Database } from './database.types'

/**
 * Client Supabase per il browser: usa solo la anon key.
 * Tutte le letture/scritture sono filtrate dalle policy RLS lato database.
 * È `null` quando Supabase non è configurato: l'interfaccia lo segnala
 * invece di simulare dati.
 */
export const supabase: SupabaseClient<Database> | null = env.isSupabaseConfigured
  ? createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    })
  : null

export function requireSupabase(): SupabaseClient<Database> {
  if (!supabase) throw new Error('Supabase non è configurato. Imposta VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.')
  return supabase
}
