/** Tipi di scripts/staging-e2e.mjs (usati dai test). */
export const OBJECTIVE: string
export const LIMITS: { max_results: number; analyze_top: number; proposals_top: number }
export function assertSafeTarget(env: Record<string, string | undefined>): string
export function clampParams(params: Record<string, unknown>): Record<string, unknown> & { max_results: number; analyze_top: number; proposals_top: number }
export function summarize(input: { workflow: Record<string, unknown> | null; steps: Record<string, unknown>[]; runs: Record<string, unknown>[]; approvals: Record<string, unknown>[]; timings: Record<string, number>; errors: unknown[] }): Record<string, unknown>
