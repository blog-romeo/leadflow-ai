import { HttpError } from '../http'
import { log } from '../log'

/** Errore PostgREST/Postgres (sottoinsieme). */
export interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const CODE_RE = /^[a-z][a-z0-9_]{2,60}$/

/**
 * Converte gli errori delle RPC (che verificano ruoli e limiti al loro interno) in risposte HTTP
 * con codici stabili, senza esporre messaggi interni del database.
 */
export function rpcHttpError(op: string, error: DbError): HttpError {
  const msg = (error.message ?? '').trim()
  const code = CODE_RE.test(msg) ? msg : null
  let details: Record<string, unknown> = {}
  try {
    const d = error.details ? (JSON.parse(error.details) as Record<string, unknown>) : {}
    for (const k of ['limit', 'retry_after', 'cap_usd', 'spent_usd', 'provider', 'feature', 'plan_code'] as const) if (d[k] !== undefined) details[k] = d[k]
  } catch {
    details = {}
  }
  switch (error.code) {
    case '42501':
      return new HttpError(403, 'forbidden')
    case 'P0002':
      return new HttpError(404, code ?? 'not_found')
    case '22023':
    case '23514':
    case '22P02':
      return new HttpError(400, code && error.code === '22023' ? code : 'invalid_input')
    case '23505':
      return new HttpError(409, 'already_exists')
    case 'P0001':
      if (code === 'rate_limited') return new HttpError(429, 'rate_limited', { retry_after: Number(details.retry_after ?? 60) })
      if (code?.startsWith('billing_')) return new HttpError(402, code, details)
      if (code?.startsWith('platform_')) return new HttpError(503, code, details)
      return new HttpError(409, code ?? 'conflict', details)
    default:
      log('error', 'control_rpc.error', { op, code: error.code })
      return new HttpError(500, 'storage_error')
  }
}

export async function rpc<T>(db: { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: DbError | null }> }, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw rpcHttpError(fn, error)
  return data as T
}
