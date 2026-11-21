/** Tipi di scripts/stripe-preflight.mjs (usati dai test). */
export type Level = 'ok' | 'warn' | 'error'
export interface Issue { level: Level; msg: string }
export const EXPECTED_PLANS: Record<'starter' | 'business' | 'enterprise', number>
export const EXPECTED_RESELLER: Record<'agency' | 'premium', { monthly: number; setup: number }>
export const REQUIRED_EVENTS: string[]
export function keyMode(key: string | undefined): 'test' | 'live' | null
export function checkPrice(price: unknown, opts: { amount: number; kind: 'recurring' | 'one_time'; automaticTax: boolean }): Issue[]
export function checkWebhooks(endpoints: unknown[] | undefined, siteUrl: string): Issue[]
export function checkPortal(configs: unknown[] | undefined): Issue[]
export function checkTax(settings: unknown, registrations: unknown[] | undefined, automaticTax: boolean): Issue[]
export function runPreflight(env?: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<{ area: string; issues: Issue[] }[]>
