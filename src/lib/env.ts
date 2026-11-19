/**
 * Configurazione pubblica lato client. Contiene SOLO valori pubblicabili.
 * Le chiavi segrete (service role, OpenAI, Stripe) vivono esclusivamente
 * nelle Netlify Functions e non devono mai avere il prefisso VITE_.
 */
const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

function isPlaceholder(value: string): boolean {
  return value === '' || value.includes('your-project-ref') || value.startsWith('your-')
}

export const env = {
  supabaseUrl: url,
  supabaseAnonKey: anonKey,
  appUrl: (import.meta.env.VITE_APP_URL ?? '').trim() || (typeof window !== 'undefined' ? window.location.origin : ''),
  isSupabaseConfigured: !isPlaceholder(url) && !isPlaceholder(anonKey),
} as const
