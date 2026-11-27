import { createHash, createHmac, randomBytes } from 'node:crypto'
import { HttpError } from '../http'
import { log } from '../log'
import type { DemandHunterConfig } from './config'
import type { Ctx } from './types'

/**
 * Gateway sicuro Netlify → servizio Python Demand Hunter.
 *
 * Ogni richiesta è firmata con HMAC-SHA256 (DEMAND_HUNTER_SERVICE_SECRET) su:
 *   timestamp \n nonce \n METODO \n path?query \n organization_id \n user_id \n sha256(body)
 * L'organizzazione e l'utente arrivano SOLO dal contesto già autorizzato (requireOrgMember): il browser non
 * parla mai con il servizio e non conosce il segreto. Il servizio rifiuta firme scadute o riusate.
 * Gli errori del servizio non vengono inoltrati al browser così come sono: diventano codici stabili.
 */
export interface ServiceClient {
  call<T>(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T>
}

export function canonical(ts: string, nonce: string, method: string, path: string, org: string, user: string, body: string): string {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex')
  return [ts, nonce, method.toUpperCase(), path, org, user, bodyHash].join('\n')
}

export function signRequest(secret: string, ts: string, nonce: string, method: string, path: string, org: string, user: string, body: string): string {
  return createHmac('sha256', secret).update(canonical(ts, nonce, method, path, org, user, body), 'utf8').digest('hex')
}

const SAFE_CODE = /^[a-z][a-z0-9_]{2,60}$/

export function createServiceClient(config: DemandHunterConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): ServiceClient {
  return {
    async call<T>(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
      if (!path.startsWith('/v1/')) throw new Error('invalid service path')
      const raw = body === undefined ? '' : JSON.stringify(body)
      const ts = String(Math.floor(now() / 1000))
      const nonce = randomBytes(18).toString('base64url')
      const headers: Record<string, string> = {
        'x-dh-timestamp': ts,
        'x-dh-nonce': nonce,
        'x-dh-org': ctx.orgId,
        'x-dh-user': ctx.userId,
        'x-dh-signature': signRequest(config.secret, ts, nonce, method, path, ctx.orgId, ctx.userId, raw),
      }
      if (raw) headers['content-type'] = 'application/json'
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000)
      let res: Response
      try {
        res = await fetchImpl(`${config.url}${path}`, { method, headers, body: raw || undefined, signal: ctrl.signal, redirect: 'error' })
      } catch (err) {
        log('warn', 'demand_hunter.service_unreachable', { path: path.split('?')[0], aborted: (err as Error)?.name === 'AbortError' })
        throw new HttpError(503, 'demand_hunter_service_unreachable')
      } finally {
        clearTimeout(timer)
      }
      let data: unknown = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (res.ok) return data as T
      const detail = (data as { detail?: unknown; error?: unknown } | null) ?? {}
      const code = typeof detail.error === 'string' ? detail.error : typeof detail.detail === 'string' ? detail.detail : ''
      log('warn', 'demand_hunter.service_error', { path: path.split('?')[0], status: res.status, code: SAFE_CODE.test(code) ? code : 'text' })
      if (res.status === 401 || res.status === 503) throw new HttpError(503, 'demand_hunter_service_unavailable')
      if (res.status === 404) throw new HttpError(404, 'not_found')
      if (res.status === 409) throw new HttpError(409, 'duplicate_request')
      if (res.status === 429) throw new HttpError(429, 'too_many_running_hunts')
      // 400 di BuyerML: messaggio in italiano scritto dal codice originale (es. "Scrivi l'oggetto da cercare"), mai dati interni.
      if (res.status === 400 || res.status === 422) {
        throw new HttpError(400, 'demand_hunter_invalid_request', SAFE_CODE.test(code) ? { reason: code } : code ? { message: code.slice(0, 160) } : {})
      }
      throw new HttpError(502, 'demand_hunter_service_error')
    },
  }
}
