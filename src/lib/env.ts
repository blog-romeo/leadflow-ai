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
  /**
   * Prompt 8: mostra nel menu le pagine del motore multi-agent (beta privata). Solo visibilità: le API
   * restano protette lato server da AI_AGENTS_ENABLED / AI_AGENTS_PILOT_ORGS.
   */
  featureAiAgents: (import.meta.env.VITE_FEATURE_AI_AGENTS ?? '').trim() === 'true',
  /** Prompt 13: chatbot di assistenza (sito e app). Attivo salvo VITE_FEATURE_SUPPORT_CHAT=false. */
  featureSupportChat: (import.meta.env.VITE_FEATURE_SUPPORT_CHAT ?? '').trim() !== 'false',
  /** Prompt 13: beta gratuita. Solo presentazione (pagina prezzi); l'accesso lo concede il database (free_beta_enabled). */
  featureFreeBeta: (import.meta.env.VITE_FREE_BETA ?? '').trim() === 'true',
} as const
