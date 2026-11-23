/**
 * Risoluzione centralizzata delle variabili Supabase lato server.
 *
 * Il progetto Netlify può esporre i nomi "classici" (SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY) oppure quelli delle nuove chiavi API Supabase
 * (SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY) creati dall'integrazione Netlify ↔ Supabase.
 * In precedenza il codice leggeva solo i nomi classici: con le sole chiavi nuove ogni API
 * autenticata rispondeva 503 server_not_configured (Copilot, Assistente, Automazioni, AI…).
 *
 * La chiave segreta resta SOLO server-side: VITE_* contiene esclusivamente valori pubblici.
 */
type Env = NodeJS.ProcessEnv

const first = (env: Env, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = env[k]?.trim()
    if (v) return v
  }
  return undefined
}

export const SUPABASE_URL_KEYS = ['SUPABASE_URL', 'VITE_SUPABASE_URL']
export const SUPABASE_ANON_KEYS = ['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ANON_KEY']
export const SUPABASE_SERVICE_KEYS = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']

export const supabaseUrl = (env: Env = process.env) => first(env, SUPABASE_URL_KEYS)
export const supabaseAnonKey = (env: Env = process.env) => first(env, SUPABASE_ANON_KEYS)
export const supabaseServiceKey = (env: Env = process.env) => first(env, SUPABASE_SERVICE_KEYS)
