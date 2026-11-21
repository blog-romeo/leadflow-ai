import { HttpError } from '../http'

/**
 * Feature flag del motore multi-agent (Prompt 8).
 *
 * - AI_AGENTS_ENABLED=true          → abilita le API degli agenti (default: spente).
 * - AI_AGENTS_PILOT_ORGS=<uuid,...> → se impostata, solo queste organizzazioni (beta privata).
 *
 * Con il flag spento le API rispondono 404 "feature_disabled" e i workflow già creati non vengono
 * eseguiti. Il menu dell'interfaccia dipende da VITE_FEATURE_AI_AGENTS (solo visibilità: la
 * protezione è sempre lato server).
 */
export interface AgentsFlag {
  enabled: boolean
  pilotOrgs: string[] | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function agentsFlag(env: NodeJS.ProcessEnv = process.env): AgentsFlag {
  const enabled = env.AI_AGENTS_ENABLED === 'true'
  const raw = (env.AI_AGENTS_PILOT_ORGS ?? '').trim()
  const pilotOrgs = raw ? raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)) : null
  return { enabled, pilotOrgs }
}

export function agentsEnabledFor(orgId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const f = agentsFlag(env)
  if (!f.enabled) return false
  return !f.pilotOrgs || f.pilotOrgs.includes(orgId.toLowerCase())
}

export function assertAgentsEnabled(orgId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!agentsEnabledFor(orgId, env)) throw new HttpError(404, 'feature_disabled')
}
