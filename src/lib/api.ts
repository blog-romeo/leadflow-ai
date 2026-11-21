import { supabase } from './supabase'

/** Errore restituito dalle Netlify Functions: codice stabile + dettagli (mai dati interni). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

/**
 * Chiamata alle API server con il JWT dell'utente. Nessuna chiave segreta nel browser:
 * l'autorizzazione è verificata dalle functions su ogni richiesta.
 */
export async function apiFetch<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; raw?: boolean } = {}): Promise<T> {
  if (!supabase) throw new ApiError(0, 'not_configured')
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new ApiError(401, 'missing_token')
  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'network')
  }
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok) {
    if (!type.includes('application/json')) throw new ApiError(res.status, res.status === 404 ? 'api_unavailable' : 'generic')
    const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>
    const { error, ...details } = body
    throw new ApiError(res.status, error ?? 'generic', details)
  }
  if (init.raw) return (await res.blob()) as T
  if (!type.includes('application/json')) throw new ApiError(res.status, 'api_unavailable')
  return (await res.json()) as T
}

/** Messaggio leggibile per un errore delle API Lead Finder. */
export function apiErrorMessage(err: unknown, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!(err instanceof ApiError)) return t('leadFinder.errors.generic')
  const d = err.details
  // Rifiuti di piano/quote (402): abbonamento, funzionalità, crediti o lead del periodo.
  if (err.code.startsWith('billing_')) {
    const bk = `billing.errors.${err.code}`
    const bm = t(bk, { used: Number(d.used ?? 0), limit: Number(d.limit ?? 0), remaining: Number(d.remaining ?? 0) })
    return bm === bk ? t('billing.errors.billing_generic') : bm
  }
  const key = `leadFinder.errors.${err.code}`
  const msg = t(key, {
    used: Number(d.used ?? 0),
    limit: Number(d.limit ?? 0),
    seconds: Number(d.retry_after ?? 60),
  })
  return msg === key ? t('leadFinder.errors.generic') : msg
}
