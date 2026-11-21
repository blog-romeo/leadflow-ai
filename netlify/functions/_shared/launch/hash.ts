import { createHmac } from 'node:crypto'

/**
 * Identificativo pseudonimo per i limiti di frequenza: HMAC-SHA256 dell'IP con un segreto
 * server (LEADFLOW_INTERNAL_SECRET) e lo scopo. L'IP in chiaro non viene mai salvato e
 * l'hash non è reversibile né confrontabile tra scopi diversi.
 */
export function rateKey(ip: string, scope: string, secret = process.env.LEADFLOW_INTERNAL_SECRET ?? ''): string | null {
  if (!secret || secret.length < 32) return null
  return createHmac('sha256', secret).update(`${scope}:${ip}`).digest('hex')
}

/** IP del client come visto da Netlify (header impostato dalla piattaforma, non dal browser). */
export function clientIp(req: Request): string {
  return (req.headers.get('x-nf-client-connection-ip') ?? '').trim() || 'unknown'
}
