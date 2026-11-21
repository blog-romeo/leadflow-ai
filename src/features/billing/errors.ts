import { ApiError } from '../../lib/api'

type T = (k: string, v?: Record<string, string | number>) => string

/**
 * Messaggio per i rifiuti di piano/quote (codici "billing_*" dalle API con 402 o dai trigger
 * del database). Restituisce null se l'errore non riguarda il billing.
 */
export function billingErrorMessage(err: unknown, t: T): string | null {
  const code = err instanceof ApiError ? err.code : ((err as { message?: string } | null)?.message ?? '').split(':')[0]?.trim() ?? ''
  if (!/^billing_[a-z_]+$/.test(code)) return null
  const d = err instanceof ApiError ? err.details : {}
  const key = `billing.errors.${code}`
  const msg = t(key, { used: Number(d.used ?? 0), limit: Number(d.limit ?? 0), remaining: Number(d.remaining ?? 0) })
  return msg === key ? t('billing.errors.billing_generic') : msg
}

/** Messaggio per gli errori delle API di billing (checkout, portale, cambio piano). */
export function billingApiErrorMessage(err: unknown, t: T): string {
  const b = billingErrorMessage(err, t)
  if (b) return b
  if (err instanceof ApiError) {
    const key = `billing.errors.${err.code}`
    const msg = t(key)
    if (msg !== key) return msg
  }
  return t('billing.errors.generic')
}
