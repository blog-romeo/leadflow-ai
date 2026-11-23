import { supabaseUrl, supabaseServiceKey } from './env'
import { createHash } from 'node:crypto'

/**
 * Tracciamento errori senza servizi esterni: gli errori vengono sanificati e aggregati per
 * impronta nella tabella app_errors (Supabase), visibile nella console super admin → Sistema.
 * Nessun dato personale: email, numeri, UUID, URL con query e token vengono rimossi PRIMA
 * del salvataggio. Questo modulo non importa http.ts / supabaseAdmin.ts (niente dipendenze
 * circolari) e usa direttamente l'endpoint REST RPC di Supabase con la service role.
 * Un servizio esterno (es. Sentry) può essere aggiunto in seguito: non è integrato.
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const SECRETLIKE = /\b(sk|rk|pk|whsec|re|eyJ)[A-Za-z0-9_-]{8,}\b/g
const URLQUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/gi
const LONGNUM = /\d{4,}/g

export function sanitizeMessage(input: unknown, max = 300): string {
  const s = typeof input === 'string' ? input : input instanceof Error ? input.message : String(input ?? '')
  return s
    .replace(EMAIL, '<email>')
    .replace(UUID, '<id>')
    .replace(SECRETLIKE, '<secret>')
    .replace(URLQUERY, '$1?<query>')
    .replace(LONGNUM, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Percorso senza query string e con gli ID normalizzati, per aggregare gli errori. */
export function sanitizePath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  return path.split(/[?#]/)[0]!.replace(UUID, ':id').replace(/\/\d+(?=\/|$)/g, '/:n').slice(0, 200)
}

export function fingerprint(...parts: (string | null | undefined)[]): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('|')).digest('hex').slice(0, 32)
}

export interface ErrorReport {
  source: 'client' | 'function'
  code: string
  message?: unknown
  path?: unknown
  release?: string | null
}

export function buildErrorRow(r: ErrorReport) {
  const code = sanitizeMessage(r.code, 80) || 'unknown'
  const message = r.message === undefined ? null : sanitizeMessage(r.message)
  const path = sanitizePath(r.path)
  const release = typeof r.release === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(r.release) ? r.release : null
  return {
    p_source: r.source,
    p_code: code,
    p_message: message,
    p_path: path,
    p_release: release,
    // L'impronta ignora il messaggio esatto (che può variare) ma include il primo frammento normalizzato.
    p_fingerprint: fingerprint(r.source, code, path, (message ?? '').slice(0, 80)),
  }
}

/** Registra un errore. Non lancia mai: il monitoraggio non deve rompere la risposta. */
export async function reportError(r: ErrorReport, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = supabaseUrl()
  const key = supabaseServiceKey()
  if (!url || !key) return false
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/rpc/record_app_error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify(buildErrorRow(r)),
      signal: AbortSignal.timeout(2500),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Release corrente (Netlify espone COMMIT_REF in build e runtime delle functions). */
export function currentRelease(): string | null {
  const ref = process.env.COMMIT_REF
  return ref ? ref.slice(0, 12) : null
}
