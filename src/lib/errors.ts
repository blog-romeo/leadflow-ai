/** Traduce errori Supabase/Postgres in chiavi i18n leggibili, senza esporre dettagli interni. */
export function errorKey(err: unknown): string {
  const msg = (err as { message?: string } | null)?.message?.toLowerCase() ?? ''
  const code = (err as { code?: string } | null)?.code ?? ''
  if (msg.includes('invalid login credentials')) return 'errors.invalidCredentials'
  if (msg.includes('email not confirmed')) return 'errors.emailNotConfirmed'
  if (msg.includes('already registered') || msg.includes('already been registered')) return 'errors.alreadyRegistered'
  if (msg.includes('rate limit') || code === '429') return 'errors.rateLimited'
  if (code === '42501' || msg.includes('permission denied') || msg.includes('row-level security')) return 'errors.forbidden'
  if (msg.includes('organization_limit')) return 'errors.orgLimit'
  if (msg.includes('failed to fetch') || msg.includes('network')) return 'errors.network'
  return 'errors.generic'
}
