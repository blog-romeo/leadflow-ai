import { ApiError } from '../../lib/api'

/** Messaggio leggibile per gli errori delle API Demand Hunter (codici stabili del gateway). */
export function dhErrorMessage(err: unknown, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!(err instanceof ApiError)) return t('demandHunter.errors.generic')
  if (err.code.startsWith('billing_')) {
    const k = `billing.errors.${err.code}`
    const m = t(k)
    return m === k ? t('billing.errors.billing_generic') : m
  }
  const key = `demandHunter.errors.${err.code}`
  const msg = t(key, { seconds: Number(err.details.retry_after ?? 60) })
  if (msg !== key) return msg
  if (err.code === 'demand_hunter_invalid_request' && typeof err.details.message === 'string') return err.details.message
  return t('demandHunter.errors.generic')
}
