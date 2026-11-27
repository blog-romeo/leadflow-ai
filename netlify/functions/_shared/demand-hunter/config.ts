/**
 * Configurazione server-side del gateway verso il servizio Python Demand Hunter.
 * Nessuna di queste variabili ha il prefisso VITE_: non arrivano mai al browser.
 *
 *   DEMAND_HUNTER_SERVICE_URL     URL HTTPS del servizio (server dedicato, Docker)
 *   DEMAND_HUNTER_SERVICE_SECRET  segreto HMAC condiviso con il servizio (≥ 32 caratteri)
 *   DEMAND_HUNTER_ENABLED         "false" disattiva il modulo per tutte le organizzazioni
 *   DEMAND_HUNTER_ALLOW_HTTP      "true" solo in sviluppo locale (http://localhost)
 */
export interface DemandHunterConfig {
  url: string
  secret: string
}

export type ConfigState = { config: DemandHunterConfig | null; enabled: boolean; missing: string[]; invalid: string[] }

export function readDemandHunterConfig(env: NodeJS.ProcessEnv = process.env): ConfigState {
  const enabled = (env.DEMAND_HUNTER_ENABLED ?? '').trim().toLowerCase() !== 'false'
  const rawUrl = (env.DEMAND_HUNTER_SERVICE_URL ?? '').trim().replace(/\/+$/, '')
  const secret = (env.DEMAND_HUNTER_SERVICE_SECRET ?? '').trim()
  const missing: string[] = []
  const invalid: string[] = []
  if (!rawUrl) missing.push('DEMAND_HUNTER_SERVICE_URL')
  if (!secret) missing.push('DEMAND_HUNTER_SERVICE_SECRET')
  else if (secret.length < 32) invalid.push('DEMAND_HUNTER_SERVICE_SECRET')
  if (rawUrl) {
    try {
      const u = new URL(rawUrl)
      const allowHttp = env.DEMAND_HUNTER_ALLOW_HTTP === 'true' && ['localhost', '127.0.0.1'].includes(u.hostname)
      if (!(u.protocol === 'https:' || (u.protocol === 'http:' && allowHttp)) || u.username || u.password) invalid.push('DEMAND_HUNTER_SERVICE_URL')
    } catch {
      invalid.push('DEMAND_HUNTER_SERVICE_URL')
    }
  }
  const config = enabled && !missing.length && !invalid.length ? { url: rawUrl, secret } : null
  return { config, enabled, missing, invalid }
}
