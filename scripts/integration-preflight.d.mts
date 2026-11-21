/** Tipi di scripts/integration-preflight.mjs (usati dai test). */
export interface PreflightIssue { area: string; level: 'ok' | 'warn' | 'error'; msg: string }
export function checkConfig(env: Record<string, string | undefined>): PreflightIssue[]
export function checkNetwork(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<PreflightIssue[]>
export function runIntegrationPreflight(env?: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<{ network_checks: boolean; errors: number; issues: PreflightIssue[] }>
