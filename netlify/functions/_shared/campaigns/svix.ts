import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifica delle firme webhook nel formato Svix (usato da Resend):
 * contenuto firmato = `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256 con il
 * segreto `whsec_<base64>`, header `svix-signature` = elenco "v1,<base64>" separati da spazio.
 * Il timestamp deve essere entro la tolleranza (protezione da replay).
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300

export type WebhookCheck = { ok: true; id: string; timestamp: number } | { ok: false; reason: 'missing_headers' | 'bad_secret' | 'stale' | 'bad_signature' }

export function verifySvix(rawBody: string, headers: Headers, secret: string, now = Date.now()): WebhookCheck {
  const id = headers.get('svix-id') ?? headers.get('webhook-id')
  const ts = headers.get('svix-timestamp') ?? headers.get('webhook-timestamp')
  const sig = headers.get('svix-signature') ?? headers.get('webhook-signature')
  if (!id || !ts || !sig) return { ok: false, reason: 'missing_headers' }
  const timestamp = Number(ts)
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' }
  const key = secret.startsWith('whsec_') ? secret.slice(6) : secret
  let keyBytes: Buffer
  try {
    keyBytes = Buffer.from(key, 'base64')
  } catch {
    return { ok: false, reason: 'bad_secret' }
  }
  if (keyBytes.length < 16) return { ok: false, reason: 'bad_secret' }
  const expected = createHmac('sha256', keyBytes).update(`${id}.${ts}.${rawBody}`).digest()
  for (const part of sig.split(' ')) {
    const [version, value] = part.split(',')
    if (version !== 'v1' || !value) continue
    let got: Buffer
    try {
      got = Buffer.from(value, 'base64')
    } catch {
      continue
    }
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, id, timestamp }
  }
  return { ok: false, reason: 'bad_signature' }
}

/** Solo per i test: firma un payload come farebbe il provider. */
export function signSvix(rawBody: string, secret: string, id: string, timestamp: number): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`
}
