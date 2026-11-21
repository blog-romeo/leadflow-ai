/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_APP_URL?: string
  // Facoltativa: identificativo della release (es. COMMIT_REF di Netlify) allegato agli errori del browser.
  readonly VITE_RELEASE?: string
  // Prompt 8: "true" mostra nel menu AI Agents e AI Workflows (beta privata; protezione lato server).
  readonly VITE_FEATURE_AI_AGENTS?: string
  readonly VITE_FEATURE_SUPPORT_CHAT?: string
  readonly VITE_FREE_BETA?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
