/**
 * Stato mostrato per ogni connessione (Prompt 10). Un provider risulta "verificato" SOLO se l'ultimo esito
 * reale scritto dal server è 'verified' e ha meno di 24 ore: la sola presenza delle variabili non basta.
 */
export type ConnectionKey = 'openai_standard' | 'openai_economy' | 'openai_advanced' | 'overpass'
export interface ConnectionCheck { key: string; status: 'verified' | 'failed' | 'not_configured'; code: string; latency_ms: number | null; checked_at: string }
export type ConnectionUiState = 'not_configured' | 'configured_unverified' | 'verified' | 'verification_stale' | 'failed'

export const CONNECTION_KEYS: ConnectionKey[] = ['openai_standard', 'openai_economy', 'openai_advanced', 'overpass']
export const VERIFIED_TTL_MS = 24 * 3_600_000

export function connectionState(configured: boolean, check: ConnectionCheck | undefined, now = Date.now()): ConnectionUiState {
  if (!configured) return 'not_configured'
  if (!check || check.status === 'not_configured') return 'configured_unverified'
  if (check.status === 'failed') return 'failed'
  return now - new Date(check.checked_at).getTime() > VERIFIED_TTL_MS ? 'verification_stale' : 'verified'
}

/** Configurazione dichiarata dal server (solo booleani) per ciascuna connessione. */
export function configuredFor(key: ConnectionKey, av: { ai: { configured: boolean }; providers: { id: string; configured: boolean }[]; models: Record<string, { model_configured: boolean; fallback: boolean }> }): boolean {
  if (key === 'overpass') return av.providers.some((p) => p.id === 'osm_overpass' && p.configured)
  if (!av.ai.configured) return false
  const tier = key.replace('openai_', '')
  const m = av.models[tier]
  // Un livello che ricade sul modello standard non ha un modello proprio da verificare.
  return !!m && m.model_configured && !m.fallback
}
