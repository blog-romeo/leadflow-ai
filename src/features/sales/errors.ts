import { ApiError } from '../../lib/api'

type T = (k: string, v?: Record<string, string | number>) => string

const DB_CODES = ['lead_not_contactable', 'proposal_locked', 'draft_locked', 'invalid_transition'] as const

/** Messaggio leggibile per errori delle API del Sales Agent o dei vincoli del database. */
export function salesErrorMessage(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    const d = err.details
    const key = `sales.errors.${err.code}`
    const msg = t(key, { used: Number(d.used ?? 0), limit: Number(d.limit ?? 0), seconds: Number(d.retry_after ?? 60) })
    if (msg !== key) return msg
    const lf = `leadFinder.errors.${err.code}`
    const m2 = t(lf, { used: Number(d.used ?? 0), limit: Number(d.limit ?? 0), seconds: Number(d.retry_after ?? 60) })
    return m2 !== lf ? m2 : t('sales.errors.generic')
  }
  const e = err as { message?: string; code?: string } | null
  const msg = e?.message ?? ''
  const hit = DB_CODES.find((c) => msg.includes(c))
  if (hit) return t(`sales.errors.${hit}`)
  if (e?.code === '42501' || /row-level security|permission denied/i.test(msg)) return t('sales.errors.forbidden')
  if (e?.code === '23514' || e?.code === '22023') return t('sales.errors.invalid_input')
  if (/failed to fetch|network/i.test(msg)) return t('sales.errors.network')
  return t('sales.errors.generic')
}

/** Motivo leggibile del fallimento di un job (codice salvato in ai_jobs.error). */
export function jobErrorReason(code: string | null | undefined, t: T): string {
  if (!code) return t('sales.errors.internal_error')
  const key = `sales.errors.${code}`
  const m = t(key)
  return m === key ? code : m
}
